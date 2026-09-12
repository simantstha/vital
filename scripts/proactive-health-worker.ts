import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { ApnsClient } from '../lib/apnsClient';
import { generateDailyBriefFromDb } from '../lib/brain/brief';
import { getDailyBrief, upsertDailyBrief } from '../lib/brain/dailyBriefRepository';
import { prewarmDailyBrief } from '../lib/dailyBriefPrewarm';
import { previousRunSignatures, recordFindings } from '../lib/insights/confirmation';
import { insightsEnabled, runInsightPass, selectInsightPassUsers, type InsightPassRepository, type InsightPassUserSource } from '../lib/insights/nudgeWorker';
import { establishedMetrics, loadSeries } from '../lib/insights/series';
import { generateAnalysis, proactiveAnalysisModel, type AnalysisFailureEvent } from '../lib/proactiveAnalysisGeneration';
import { currentLocalDate, deliverNotification, runClaimedAnalysis, type AnalysisContext, type AnalysisJob, type CoachAnalysis } from '../lib/proactiveHealthWorker';
import { claimAnalysisJobs, claimDueMorningBriefs, completeMorningBrief, ensureDefaultPreferencesForRegisteredUsers, failMorningBrief, listReadyNotificationCandidates, workerRepository } from '../lib/proactiveHealthWorkerRepository';
import { analysisAlert, workerErrorEvent, type WorkerStage } from '../lib/proactiveHealthWorkerSupport';
import { recordDelivery, type NotificationType } from '../lib/notificationInbox';
import { getUserUnitSystem } from '../lib/units';
import { createWhoopTokenStore } from '../lib/whoop/client';
import { createWhoopSyncRepository, runWhoopSync } from '../lib/whoop/sync';
import { createWhoopWorkerRepository, runWhoopWorkerPass } from '../lib/whoop/workerPass';

const intervalMs = Number(process.env.PROACTIVE_WORKER_INTERVAL_MS ?? 15_000);
const anthropic = new Anthropic({ apiKey: required('ANTHROPIC_API_KEY') });
const apns = new ApnsClient({ keyId: required('APNS_KEY_ID'), teamId: required('APNS_TEAM_ID'), topic: required('APNS_TOPIC'), privateKey: required('APNS_PRIVATE_KEY').replace(/\\n/g, '\n') });
const whoopWorkerRepository = createWhoopWorkerRepository(db, schema);
const whoopTokenStore = createWhoopTokenStore(db, schema);
const whoopSyncRepository = createWhoopSyncRepository(db, schema);

const reportAnalysisFailure = (event: AnalysisFailureEvent): void => {
  console.error(JSON.stringify(event));
};

async function analyze(job: AnalysisJob, context: AnalysisContext): Promise<CoachAnalysis> {
  return generateAnalysis({
    source: { kind: job.kind, date: job.localDate, input: job.input, availableContext: context },
    units: context.unitSystem,
    generate: async (request) => {
      const response = await anthropic.messages.create({
        model: proactiveAnalysisModel(process.env),
        max_tokens: 1500,
        system: request.system,
        messages: [{ role: 'user', content: request.content }],
      });
      const textBlocks = response.content.filter((item) => item.type === 'text');
      if (textBlocks.length !== 1) throw new Error('analysis model returned no text');
      return textBlocks[0].text;
    },
    report: reportAnalysisFailure,
  });
}

async function generateNudge(request: { system: string; content: string }): Promise<string> {
  const response = await anthropic.messages.create({
    model: proactiveAnalysisModel(process.env),
    max_tokens: 500,
    system: request.system,
    messages: [{ role: 'user', content: request.content }],
  });
  const textBlocks = response.content.filter((item) => item.type === 'text');
  if (textBlocks.length !== 1) throw new Error('insight nudge model returned no text');
  return textBlocks[0].text;
}

// Drizzle-backed InsightPassRepository. loadSeries/establishedMetrics/
// recordFindings/previousRunSignatures already do their own DB I/O (see
// lib/insights/series.ts and confirmation.ts) and are reused directly; the
// remaining methods are new queries this stage needs (sent-nudge history for
// caps/cooldown, voice context, and the pending_nudges write path).
const insightPassRepository: InsightPassRepository = {
  loadSeries,
  establishedMetrics,
  recordFindings,
  previousRunSignatures,
  async sentNudgeHistory(userId, now) {
    const since = new Date(now.getTime() - 14 * 24 * 60 * 60_000); // covers both the 7-day cap and the 14-day cooldown
    const rows = await db
      .select({ kind: schema.pending_nudges.finding_kind, sentAt: schema.pending_nudges.sent_at })
      .from(schema.pending_nudges)
      .where(and(eq(schema.pending_nudges.user_id, userId), gte(schema.pending_nudges.sent_at, since)));
    return rows.filter((row): row is { kind: string; sentAt: Date } => row.kind !== null && row.sentAt !== null);
  },
  async voiceContext(userId) {
    const [user] = await db.select({ goal: schema.users.goal }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const facts = await db.select({ label: schema.nodes.label }).from(schema.nodes).where(and(eq(schema.nodes.user_id, userId), eq(schema.nodes.status, 'active')));
    const recentNudges = await db
      .select({ payload: schema.pending_nudges.payload })
      .from(schema.pending_nudges)
      .where(and(eq(schema.pending_nudges.user_id, userId), isNotNull(schema.pending_nudges.sent_at)))
      .orderBy(desc(schema.pending_nudges.sent_at))
      .limit(5);
    const recentlySaid = recentNudges
      .map((row) => (row.payload as { openingMessage?: unknown } | null)?.openingMessage)
      .filter((value): value is string => typeof value === 'string');
    return { goal: user?.goal ?? null, facts: facts.map((f) => f.label), recentlySaid };
  },
  async insertPendingNudge(userId, localDay, kind, nudge, now) {
    // onConflictDoNothing + an empty .returning() is the race resolution: the
    // unique index on (user_id, local_day) lets exactly one concurrent
    // worker's insert succeed for a given user's day, and the loser gets no
    // row back here rather than an error — see nudgeWorker.ts's contract.
    const rows = await db.insert(schema.pending_nudges).values({
      user_id: userId,
      type: 'coach_nudge',
      payload: { title: nudge.title, body: nudge.body, openingMessage: nudge.openingMessage, signature: nudge.signature },
      scheduled_for: now,
      finding_kind: kind,
      local_day: localDay,
    })
      .onConflictDoNothing({ target: [schema.pending_nudges.user_id, schema.pending_nudges.local_day] })
      .returning({ id: schema.pending_nudges.id });
    return rows[0]?.id ?? null;
  },
  async markNudgeSent(pendingNudgeId, now) {
    await db.update(schema.pending_nudges).set({ sent_at: now }).where(eq(schema.pending_nudges.id, pendingNudgeId));
  },
  listDevices: (userId) => workerRepository.listDevices(userId),
};

// Which population an insight pass evaluates depends on the mode — the branch
// and its reasoning live in selectInsightPassUsers. Both queries carry the
// user's notification timezone (UTC fallback), which resolves their local day.
const insightPassUserSource: InsightPassUserSource = {
  async listAllUsers() {
    const rows = await db
      .select({ userId: schema.users.id, timezone: schema.notification_preferences.timezone })
      .from(schema.users)
      .leftJoin(schema.notification_preferences, eq(schema.notification_preferences.user_id, schema.users.id));
    return rows.map((row) => ({ userId: row.userId, timezone: row.timezone ?? 'UTC' }));
  },
  async listUsersWithLiveDevice() {
    const rows = await db
      .selectDistinct({ userId: schema.push_devices.user_id, timezone: schema.notification_preferences.timezone })
      .from(schema.push_devices)
      .leftJoin(schema.notification_preferences, eq(schema.notification_preferences.user_id, schema.push_devices.user_id))
      .where(isNull(schema.push_devices.invalidated_at));
    return rows.map((row) => ({ userId: row.userId, timezone: row.timezone ?? 'UTC' }));
  },
};

// The statistical battery + (in dry-run and live) a model call are too
// expensive to redo on every ~15s tick, and — unlike the other stages —
// pending_nudges has no lease/claim columns to make repeat runs cheap. Track
// the last local day this process ran an insight pass for each user, purely
// in memory: a process restart costs at most one extra pass per user that
// day, never a correctness problem (recordFindings/previousRunSignatures are
// keyed by day and idempotent), so this doesn't need to survive restarts.
const insightPassDayByUser = new Map<string, string>();

async function runDueInsightPasses(now: Date): Promise<void> {
  const mode = insightsEnabled(process.env);
  if (mode === 'off') return;

  const users = await selectInsightPassUsers(insightPassUserSource, mode);
  for (const user of users) {
    const localDay = currentLocalDate(now, user.timezone);
    if (insightPassDayByUser.get(user.userId) === localDay) continue;
    insightPassDayByUser.set(user.userId, localDay);
    try {
      await runInsightPass({
        repository: insightPassRepository,
        generateNudge,
        push: async (device, alert, route) => {
          await recordDelivery(user.userId, route.type, route.id, alert, route.deepLink);
          return apns.send(device, alert, route);
        },
        mode,
        userId: user.userId,
        now,
        localDay,
      });
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent('insight-pass', error)));
    }
  }
}

async function tick(reportStage: (stage: WorkerStage) => void): Promise<void> {
  const now = new Date();
  reportStage('ensure-default-preferences');
  await ensureDefaultPreferencesForRegisteredUsers();

  reportStage('claim-analysis-jobs');
  const jobs = await claimAnalysisJobs(now);
  for (const job of jobs) {
    reportStage('process-analysis-job');
    const alert = analysisAlert(job.kind, job.input);
    const deepLink = `vital://${job.kind}-analysis/${job.id}`;
    const type: NotificationType = `${job.kind}_analysis`;
    // Recorded through onNotify rather than up front: runClaimedAnalysis
    // returns without notifying when the user has these notifications
    // disabled or the freshness gate rejects a stale event, and neither
    // belongs in the user's history.
    await runClaimedAnalysis(
      job, workerRepository, analyze,
      (device) => apns.send(device, alert, { type, id: job.id, deepLink }),
      now, undefined,
      () => recordDelivery(job.userId, type, job.id, alert, deepLink),
    );
  }

  reportStage('list-notification-candidates');
  const candidates = await listReadyNotificationCandidates(now);
  for (const candidate of candidates) {
    reportStage('deliver-notification');
    const token = await workerRepository.claimNotification(candidate.job, now);
    if (token) {
      const alert = analysisAlert(candidate.job.kind, candidate.job.input);
      const deepLink = `vital://${candidate.job.kind}-analysis/${candidate.job.id}`;
      const type: NotificationType = `${candidate.job.kind}_analysis`;
      await recordDelivery(candidate.job.userId, type, candidate.job.id, alert, deepLink);
      await deliverNotification(candidate.job, candidate.result, token, workerRepository, (device) => apns.send(device, alert, { type, id: candidate.job.id, deepLink }), now);
    }
  }

  reportStage('claim-morning-briefs');
  const claims = await claimDueMorningBriefs(now);
  for (const claim of claims) {
    reportStage('process-morning-brief');
    const job: AnalysisJob = { id: claim.idempotencyKey, kind: 'sleep', userId: claim.userId, localDate: claim.localDate, input: { purpose: 'morning brief' }, retryCount: 0, notificationRetryCount: claim.retryCount, leaseToken: claim.leaseToken };
    try {
      const context = await workerRepository.getContext(job);
      const result = await analyze(job, context);
      const alert = { title: result.headline, body: result.shortInsight };
      const deepLink = `vital://morning-brief/${claim.slotId}`;
      await recordDelivery(claim.userId, 'morning_brief', claim.slotId, alert, deepLink);
      await completeMorningBrief(claim, result, (device) => apns.send(device, alert, { type: 'morning_brief', id: claim.slotId, deepLink }), now);
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent('process-morning-brief', error)));
      await failMorningBrief(claim, new Date());
    }

    // Pre-warm the Today-screen daily brief (distinct from the notification
    // content above — see the plan doc's "two different morning brief
    // artifacts" note) for the SAME claimed morning slot, so it's already in
    // Postgres by the time the user opens the app. Independent of, and never
    // gated by, the notification outcome above: a failed/retried
    // notification must not block the Today brief, and vice versa. Skipped
    // when a brief for today already exists (e.g. the user opened before
    // their slot and /api/today's on-demand fallback already generated one)
    // so a retried notification slot doesn't re-spend a Claude call here.
    reportStage('prewarm-daily-brief');
    try {
      await prewarmDailyBrief(claim.userId, claim.localDate, {
        getUserUnitSystem,
        getDailyBrief,
        generateDailyBriefFromDb,
        upsertDailyBrief,
      });
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent('prewarm-daily-brief', error)));
    }
  }

  reportStage('whoop-sync');
  const whoopResult = await runWhoopWorkerPass(now, {
    listActiveConnections: () => whoopWorkerRepository.listActiveConnections(),
    runSync: (target, windowStart, windowEnd) => runWhoopSync(target, whoopTokenStore, whoopSyncRepository, windowStart, windowEnd),
  });
  // Two separable signals, logged as distinct events so `fly logs` can tell
  // "some connections are broken" apart from "WHOOP is rate-limiting us".
  if (whoopResult.failed.length > 0) {
    console.error(JSON.stringify({
      event: 'whoop_worker_pass_connection_failures',
      synced: whoopResult.synced.length,
      skipped: whoopResult.skipped.length,
      failed: whoopResult.failed.length,
    }));
  }
  if (whoopResult.backpressure) {
    console.error(JSON.stringify({
      event: 'whoop_worker_pass_backpressure',
      synced: whoopResult.synced.length,
      skipped: whoopResult.skipped.length,
      failed: whoopResult.failed.length,
    }));
  }

  if (insightsEnabled(process.env) !== 'off') {
    reportStage('insight-pass');
    await runDueInsightPasses(now);
  }
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
async function main(): Promise<void> {
  for (;;) {
    let stage: WorkerStage = 'ensure-default-preferences';
    try {
      await tick((nextStage) => { stage = nextStage; });
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent(stage, error)));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
void main();
