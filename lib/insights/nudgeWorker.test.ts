import assert from 'node:assert/strict';
import test from 'node:test';

import { COOLDOWN_DAYS } from './arbiter';
import {
  insightsEnabled,
  runInsightPass,
  withinDeliveryCaps,
  type InsightPassDeps,
  type InsightPassRepository,
  type SentNudge,
} from './nudgeWorker';
import type { MetricSeries } from './types';

const now = new Date('2026-09-07T15:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

test('mode defaults to off when unset', () => {
  assert.equal(insightsEnabled({} as NodeJS.ProcessEnv), 'off');
});

test('mode reads dry-run and live, and rejects anything else', () => {
  assert.equal(insightsEnabled({ VITAL_INSIGHTS_MODE: 'dry-run' } as unknown as NodeJS.ProcessEnv), 'dry-run');
  assert.equal(insightsEnabled({ VITAL_INSIGHTS_MODE: 'live' } as unknown as NodeJS.ProcessEnv), 'live');
  assert.equal(insightsEnabled({ VITAL_INSIGHTS_MODE: 'nonsense' } as unknown as NodeJS.ProcessEnv), 'off');
});

test('allows a nudge with no history', () => {
  assert.equal(withinDeliveryCaps([], now, 'cadence_break'), true);
});

test('blocks a second nudge on the same day', () => {
  assert.equal(
    withinDeliveryCaps([{ kind: 'trend', sentAt: new Date('2026-09-07T08:00:00Z') }], now, 'cadence_break'),
    false,
  );
});

test('blocks a fourth nudge in a week', () => {
  const history = [
    { kind: 'trend', sentAt: daysAgo(2) },
    { kind: 'level_shift', sentAt: daysAgo(4) },
    { kind: 'cross_lag', sentAt: daysAgo(6) },
  ];
  assert.equal(withinDeliveryCaps(history, now, 'cadence_break'), false);
});

test('blocks the same kind inside its 14-day cooldown', () => {
  assert.equal(
    withinDeliveryCaps([{ kind: 'cadence_break', sentAt: daysAgo(10) }], now, 'cadence_break'),
    false,
  );
});

test('allows the same kind once the cooldown has expired', () => {
  assert.equal(
    withinDeliveryCaps([{ kind: 'cadence_break', sentAt: daysAgo(15) }], now, 'cadence_break'),
    true,
  );
});

test('counts the weekly cap on a rolling window, not a calendar week', () => {
  const history = [
    { kind: 'trend', sentAt: daysAgo(8) },
    { kind: 'level_shift', sentAt: daysAgo(9) },
    { kind: 'cross_lag', sentAt: daysAgo(10) },
  ];
  assert.equal(withinDeliveryCaps(history, now, 'cadence_break'), true);
});

// ─── runInsightPass ─────────────────────────────────────────────────────────
//
// Fixtures below reuse detectors.test.ts's cadence-break shape (a metric
// active every day except a trailing silent stretch) because cadence_break is
// a rule finding (pValue: null), so it survives applyEvidenceGate without
// needing a fabricated p-value/BH scenario — the cheapest reliable way to get
// a genuine, non-fake candidate out of the REAL detectors, which
// runInsightPass calls directly rather than through deps.

const LOCAL_DAY = '2026-09-07';
const NOW = new Date('2026-09-07T15:00:00Z');

/** 90-day series ending LOCAL_DAY, active every day except the trailing `silentDays`. */
function cadenceSeries(metric: string, silentDays: number): MetricSeries {
  const points = [];
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let i = 89; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    points.push({ date: d.toISOString().slice(0, 10), value: i < silentDays ? null : 45 });
  }
  return { metric, points };
}

function flatSeries(metric: string): MetricSeries {
  const points = [];
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let i = 89; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    points.push({ date: d.toISOString().slice(0, 10), value: null });
  }
  return { metric, points };
}

interface RepoOverrides {
  series?: MetricSeries[];
  established?: Set<string>;
  previousSignatures?: Set<string>;
  history?: SentNudge[];
  facts?: string[];
  recentlySaid?: string[];
  goal?: string | null;
}

function makeRepository(overrides: RepoOverrides = {}): { repo: InsightPassRepository; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    recordFindings: [],
    insertPendingNudge: [],
    markNudgeSent: [],
  };
  const repo: InsightPassRepository = {
    async loadSeries(_userId, metrics) {
      const byMetric = new Map((overrides.series ?? []).map((s) => [s.metric, s]));
      return metrics.map((m) => byMetric.get(m) ?? flatSeries(m));
    },
    async establishedMetrics() {
      return overrides.established ?? new Set<string>();
    },
    async recordFindings(userId, localDay, findings) {
      calls.recordFindings.push({ userId, localDay, findings });
    },
    async previousRunSignatures() {
      return overrides.previousSignatures ?? new Set<string>();
    },
    async sentNudgeHistory() {
      return overrides.history ?? [];
    },
    async voiceContext() {
      return { goal: overrides.goal ?? null, facts: overrides.facts ?? [], recentlySaid: overrides.recentlySaid ?? [] };
    },
    async insertPendingNudge(userId, kind, nudge) {
      calls.insertPendingNudge.push({ userId, kind, nudge });
      return 'pending-nudge-1';
    },
    async markNudgeSent(pendingNudgeId) {
      calls.markNudgeSent.push({ pendingNudgeId });
    },
    async listDevices() {
      return [{ id: 'device-1', token: 'tok', environment: 'sandbox' as const }];
    },
  };
  return { repo, calls };
}

function makeDeps(repo: InsightPassRepository, overrides: Partial<InsightPassDeps> & { generateNudgeRaw?: string } = {}): InsightPassDeps {
  return {
    repository: repo,
    userId: 'user-1',
    now: NOW,
    localDay: LOCAL_DAY,
    mode: overrides.mode ?? 'live',
    generateNudge: overrides.generateNudge ?? (async () => overrides.generateNudgeRaw ?? JSON.stringify({
      signature: 'cadence_break:exercise_min',
      title: 'Missed a few days?',
      body: "You haven't logged a session in 5 days.",
      openingMessage: 'Noticed a gap in your training — everything okay?',
    })),
    push: overrides.push ?? (async () => ({ outcome: 'sent' as const, retireToken: false })),
  };
}

test('happy path: computes, confirms, shortlists, generates, and delivers', async () => {
  const series = cadenceSeries('exercise_min', 5); // matches detectors.test.ts's firing fixture
  const { repo, calls } = makeRepository({
    series: [series],
    established: new Set(['exercise_min']),
    previousSignatures: new Set(['cadence_break:exercise_min']),
  });
  const pushCalls: unknown[] = [];
  const deps = makeDeps(repo, { push: async (device, alert, route) => { pushCalls.push({ device, alert, route }); return { outcome: 'sent', retireToken: false }; } });

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, true);
  if (outcome.delivered) {
    assert.equal(outcome.pendingNudgeId, 'pending-nudge-1');
    assert.equal(outcome.kind, 'cadence_break');
  }
  assert.equal(calls.insertPendingNudge.length, 1);
  const inserted = calls.insertPendingNudge[0] as { kind: string };
  assert.equal(inserted.kind, 'cadence_break');
  assert.equal(pushCalls.length, 1);
  const pushed = pushCalls[0] as { route: { type: string; id: string; deepLink: string } };
  assert.deepEqual(pushed.route, { type: 'coach_nudge', id: 'pending-nudge-1', deepLink: 'vital://coach-nudge/pending-nudge-1' });
  assert.equal(calls.markNudgeSent.length, 1);
});

test('records every gate-surviving finding, not just the one spoken', async () => {
  // Two independent cadence_break candidates on two different metrics both
  // survive the gate; the model can only choose one. recordFindings must
  // still receive BOTH, per Task 11's cross-run confirmation contract.
  const exerciseSeries = cadenceSeries('exercise_min', 5);
  const strainSeries = cadenceSeries('whoop_day_strain', 5);
  const { repo, calls } = makeRepository({
    series: [exerciseSeries, strainSeries],
    established: new Set(['exercise_min', 'whoop_day_strain']),
    previousSignatures: new Set(['cadence_break:exercise_min', 'cadence_break:whoop_day_strain']),
  });
  const deps = makeDeps(repo, {
    generateNudgeRaw: JSON.stringify({
      signature: 'cadence_break:exercise_min',
      title: 'Missed a few days?',
      body: "You haven't logged a session in 5 days.",
      openingMessage: 'Noticed a gap in your training — everything okay?',
    }),
  });

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, true);
  assert.equal(calls.recordFindings.length, 1);
  const recorded = calls.recordFindings[0] as { findings: Array<{ signature: string }> };
  assert.equal(recorded.findings.length, 2);
  assert.deepEqual(
    recorded.findings.map((f) => f.signature).sort(),
    ['cadence_break:exercise_min', 'cadence_break:whoop_day_strain'],
  );
  // Only one of the two recorded findings became the spoken nudge.
  if (outcome.delivered) assert.equal(outcome.kind, 'cadence_break');
});

test('silent when no metric has an established baseline', async () => {
  const series = cadenceSeries('exercise_min', 5);
  const { repo, calls } = makeRepository({ series: [series], established: new Set() });
  const deps = makeDeps(repo);

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, false);
  if (!outcome.delivered) assert.equal(outcome.reason, 'no_candidates');
  assert.equal(calls.insertPendingNudge.length, 0);
});

test('silent when no detector produces a candidate', async () => {
  const { repo, calls } = makeRepository({ established: new Set(['exercise_min']) });
  const deps = makeDeps(repo);

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, false);
  if (!outcome.delivered) assert.equal(outcome.reason, 'no_candidates');
  assert.equal(calls.insertPendingNudge.length, 0);
});

test('silent when nothing is confirmed across two runs', async () => {
  const series = cadenceSeries('exercise_min', 5);
  const { repo, calls } = makeRepository({
    series: [series],
    established: new Set(['exercise_min']),
    previousSignatures: new Set(), // yesterday's run found nothing matching
  });
  const deps = makeDeps(repo);

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, false);
  if (!outcome.delivered) assert.equal(outcome.reason, 'not_confirmed');
  // Still recorded today's finding, even though it wasn't confirmed or spoken.
  assert.equal(calls.recordFindings.length, 1);
  const recorded = calls.recordFindings[0] as { findings: unknown[] };
  assert.equal(recorded.findings.length, 1);
  assert.equal(calls.insertPendingNudge.length, 0);
});

test('silent when the shortlist is empty (cooldown covers every confirmed finding)', async () => {
  const series = cadenceSeries('exercise_min', 5);
  const { repo, calls } = makeRepository({
    series: [series],
    established: new Set(['exercise_min']),
    previousSignatures: new Set(['cadence_break:exercise_min']),
    history: [{ kind: 'cadence_break', sentAt: daysAgo(COOLDOWN_DAYS - 1) }], // still within cooldown
  });
  const deps = makeDeps(repo);

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, false);
  if (!outcome.delivered) assert.equal(outcome.reason, 'empty_shortlist');
  assert.equal(calls.insertPendingNudge.length, 0);
});

test('silent when the model response fails to parse into a nudge', async () => {
  const series = cadenceSeries('exercise_min', 5);
  const { repo, calls } = makeRepository({
    series: [series],
    established: new Set(['exercise_min']),
    previousSignatures: new Set(['cadence_break:exercise_min']),
  });
  const deps = makeDeps(repo, { generateNudgeRaw: 'not json' });

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, false);
  if (!outcome.delivered) assert.equal(outcome.reason, 'no_nudge');
  assert.equal(calls.insertPendingNudge.length, 0);
});

test('silent when delivery caps are exceeded', async () => {
  const series = cadenceSeries('exercise_min', 5);
  const { repo, calls } = makeRepository({
    series: [series],
    established: new Set(['exercise_min']),
    previousSignatures: new Set(['cadence_break:exercise_min']),
    history: [{ kind: 'trend', sentAt: new Date('2026-09-07T08:00:00Z') }], // already sent today
  });
  const deps = makeDeps(repo);

  const outcome = await runInsightPass(deps);

  assert.equal(outcome.delivered, false);
  if (!outcome.delivered) assert.equal(outcome.reason, 'caps_exceeded');
  assert.equal(calls.insertPendingNudge.length, 0);
});

test('dry-run computes and logs but never delivers', async () => {
  const series = cadenceSeries('exercise_min', 5);
  const { repo, calls } = makeRepository({
    series: [series],
    established: new Set(['exercise_min']),
    previousSignatures: new Set(['cadence_break:exercise_min']),
  });
  const deps = makeDeps(repo, { mode: 'dry-run' });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  let outcome;
  try {
    outcome = await runInsightPass(deps);
  } finally {
    console.log = originalLog;
  }

  assert.equal(outcome.delivered, false);
  if (!outcome.delivered) assert.equal(outcome.reason, 'dry_run');
  assert.equal(calls.insertPendingNudge.length, 0);
  assert.equal(logs.length, 1);
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.stage, 'insight-dry-run');
  assert.equal(logged.userId, 'user-1');
  assert.equal(logged.nudge.signature, 'cadence_break:exercise_min');
});
