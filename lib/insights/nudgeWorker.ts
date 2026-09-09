/**
 * Worker orchestration for the proactive insight engine — the stage that
 * strings every prior module together into one pass for one user, plus the
 * two safety mechanisms that make shipping it survivable: delivery caps and
 * the dry-run rollout flag.
 *
 * Mirrors lib/proactiveHealthWorker.ts's shape: pure orchestration functions
 * (`insightsEnabled`, `withinDeliveryCaps`, `runInsightPass`) take their
 * dependencies as arguments — real DB/model/push wiring lives in
 * scripts/proactive-health-worker.ts, exactly where `analyze`/`workerRepository`
 * are composed for the existing analysis pipeline — so orchestration is
 * testable without a database, an Anthropic key, or APNs credentials.
 */
import type { PushDevice, PushOutcome } from '../proactiveHealthWorker';
import { COOLDOWN_DAYS, shortlist, type ArbiterContext } from './arbiter';
import { confirmAgainstPreviousRun } from './confirmation';
import {
  CADENCE_METRICS,
  detectCadenceBreak,
  detectCrossLag,
  detectDayOfWeek,
  detectLevelShift,
  detectTrend,
  INPUT_METRICS,
  OUTCOME_METRICS,
} from './detectors';
import { applyEvidenceGate } from './evidence';
import type { Finding, MetricSeries } from './types';
import { buildVoiceRequest, parseNudge, type Nudge } from './voice';

export interface SentNudge { kind: string; sentAt: Date }

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_DAY = 1;
const MAX_PER_WEEK = 3;

/**
 * Rollout control. `off` by default so merging this ships nothing; `dry-run`
 * computes and logs without delivering. Same env-var-as-kill-switch pattern as
 * PROACTIVE_NOTIFICATION_FRESHNESS_HOURS — flip via a Fly secret, no redeploy.
 */
export function insightsEnabled(env: NodeJS.ProcessEnv): 'off' | 'dry-run' | 'live' {
  const value = env.VITAL_INSIGHTS_MODE;
  return value === 'dry-run' || value === 'live' ? value : 'off';
}

/**
 * A coach who notices everything out loud is a nag. These caps are also the
 * last line of defence against a residual false positive: even a finding that
 * slips every statistical gate can only be said once a fortnight.
 */
export function withinDeliveryCaps(history: SentNudge[], now: Date, kind: string): boolean {
  const since = (days: number) => now.getTime() - days * DAY_MS;

  if (history.filter((n) => n.sentAt.getTime() >= since(1)).length >= MAX_PER_DAY) return false;
  if (history.filter((n) => n.sentAt.getTime() >= since(7)).length >= MAX_PER_WEEK) return false;
  if (history.some((n) => n.kind === kind && n.sentAt.getTime() >= since(COOLDOWN_DAYS))) return false;

  return true;
}

/** What runInsightPass needs about the user beyond series/findings data. */
export interface VoiceUserContext {
  goal: string | null;
  facts: string[];          // active ontology facts — see voice.ts's VoiceContext
  recentlySaid: string[];   // openings from recently SENT nudges
}

/**
 * DB-backed half of one user's insight pass. Every method is a thin wrapper
 * over a query or an existing pure module (loadSeries, establishedMetrics,
 * recordFindings, previousRunSignatures already exist in series.ts/
 * confirmation.ts and do their own DB I/O) — the interface exists so tests can
 * substitute fakes, exactly as WorkerRepository does for the analysis pipeline.
 */
export interface InsightPassRepository {
  loadSeries(userId: string, metrics: string[], endDay: string): Promise<MetricSeries[]>;
  establishedMetrics(userId: string): Promise<Set<string>>;
  /** Records the FULL gate-surviving set for the day — see runInsightPass below. */
  recordFindings(userId: string, localDay: string, findings: Finding[]): Promise<void>;
  previousRunSignatures(userId: string, localDay: string): Promise<Set<string>>;
  /** Sent nudges within the lookback the caps/cooldown/novelty logic needs (>= COOLDOWN_DAYS). */
  sentNudgeHistory(userId: string, now: Date): Promise<SentNudge[]>;
  voiceContext(userId: string): Promise<VoiceUserContext>;
  /** Inserts a pending_nudges row with finding_kind set; returns its id. */
  insertPendingNudge(userId: string, kind: string, nudge: Nudge, now: Date): Promise<string>;
  markNudgeSent(pendingNudgeId: string, now: Date): Promise<void>;
  listDevices(userId: string): Promise<PushDevice[]>;
}

export interface InsightPassDeps {
  repository: InsightPassRepository;
  /** Calls the model with the voice request; returns the raw text response. */
  generateNudge(request: { system: string; content: string }): Promise<string>;
  /** Sends one push; mirrors ApnsClient#send / analysisAlert's route shape. */
  push(
    device: PushDevice,
    alert: { title: string; body: string },
    route: { type: 'coach_nudge'; id: string; deepLink: string },
  ): Promise<PushOutcome>;
  /** Never 'off' by construction — the caller gates that before invoking this at all (see the script). */
  mode: 'dry-run' | 'live';
  userId: string;
  now: Date;
  localDay: string;
}

export type InsightSilenceReason =
  | 'no_candidates'
  | 'not_confirmed'
  | 'empty_shortlist'
  | 'no_nudge'
  | 'caps_exceeded'
  | 'dry_run';

export type InsightPassOutcome =
  | { delivered: false; reason: InsightSilenceReason }
  | { delivered: true; pendingNudgeId: string; kind: string; pushed: boolean };

function emptySeries(metric: string): MetricSeries {
  return { metric, points: [] };
}

/** Days since each kind was last sent, derived from the same history withinDeliveryCaps reads. */
function recentKindsSince(history: SentNudge[], now: Date): Map<string, number> {
  const days = new Map<string, number>();
  for (const entry of history) {
    const elapsed = (now.getTime() - entry.sentAt.getTime()) / DAY_MS;
    const existing = days.get(entry.kind);
    if (existing === undefined || elapsed < existing) days.set(entry.kind, elapsed);
  }
  return days;
}

/**
 * Runs the full battery for one user and, at most, produces one nudge.
 *
 * Every stage below can end the pass with `{ delivered: false }` and nothing
 * else — no established baselines, no candidates, nothing confirmed across
 * two runs, an empty shortlist, an unparseable model response, or delivery
 * caps exceeded. None of those are errors; a coach who has nothing worth
 * saying says nothing. Genuine failures (a DB error, a model API error) are
 * NOT caught here — they propagate to the caller, exactly like the rest of
 * this worker's stages (see scripts/proactive-health-worker.ts's per-stage
 * try/catch around tick()).
 */
export async function runInsightPass(deps: InsightPassDeps): Promise<InsightPassOutcome> {
  const { repository, userId, now, localDay, mode } = deps;

  const metrics = Array.from(new Set([...INPUT_METRICS, ...OUTCOME_METRICS]));
  const [series, established] = await Promise.all([
    repository.loadSeries(userId, metrics, localDay),
    repository.establishedMetrics(userId),
  ]);

  const seriesByMetric = new Map(series.map((s) => [s.metric, s] as const));
  const inputSeries = INPUT_METRICS.map((m) => seriesByMetric.get(m) ?? emptySeries(m));
  const outcomeSeries = OUTCOME_METRICS.map((m) => seriesByMetric.get(m) ?? emptySeries(m));

  const candidates: Finding[] = [...detectCrossLag(inputSeries, outcomeSeries)];
  for (const metric of CADENCE_METRICS) {
    const cadence = detectCadenceBreak(seriesByMetric.get(metric) ?? emptySeries(metric));
    if (cadence) candidates.push(cadence);
  }
  for (const s of [...inputSeries, ...outcomeSeries]) {
    const shift = detectLevelShift(s); if (shift) candidates.push(shift);
    const trend = detectTrend(s); if (trend) candidates.push(trend);
    const dow = detectDayOfWeek(s); if (dow) candidates.push(dow);
  }

  const survivors = applyEvidenceGate(candidates, established);

  // Records the FULL gate-surviving set — including findings that never get
  // spoken today — because tomorrow's confirmAgainstPreviousRun needs to know
  // what we found and stayed quiet about, not just what we said. Recording
  // only the eventual nudge would collapse cross-run confirmation into
  // "confirm only what we already told you," defeating the mechanism while
  // still appearing to work. Must run before any of the early returns below.
  await repository.recordFindings(userId, localDay, survivors);

  if (survivors.length === 0) return { delivered: false, reason: 'no_candidates' };

  const previousSignatures = await repository.previousRunSignatures(userId, localDay);
  const confirmed = confirmAgainstPreviousRun(survivors, previousSignatures);
  if (confirmed.length === 0) return { delivered: false, reason: 'not_confirmed' };

  const history = await repository.sentNudgeHistory(userId, now);
  const context = await repository.voiceContext(userId);

  const arbiterContext: ArbiterContext = { goal: context.goal, recentKinds: recentKindsSince(history, now) };
  const shortlisted = shortlist(confirmed, arbiterContext);
  if (shortlisted.length === 0) return { delivered: false, reason: 'empty_shortlist' };

  const request = buildVoiceRequest(shortlisted, { goal: context.goal, facts: context.facts, recentlySaid: context.recentlySaid });
  const raw = await deps.generateNudge(request);
  const nudge = parseNudge(raw, shortlisted.map((f) => f.signature));
  if (!nudge) return { delivered: false, reason: 'no_nudge' };

  // parseNudge already enforced the signature is one we offered; this lookup
  // cannot fail, but a `?? null` chain here would silently paper over a
  // contract break between voice.ts and this function, so fail the same way.
  const chosen = shortlisted.find((f) => f.signature === nudge.signature);
  if (!chosen) return { delivered: false, reason: 'no_nudge' };

  if (!withinDeliveryCaps(history, now, chosen.kind)) return { delivered: false, reason: 'caps_exceeded' };

  if (mode === 'dry-run') {
    console.log(JSON.stringify({ stage: 'insight-dry-run', userId, nudge }));
    return { delivered: false, reason: 'dry_run' };
  }

  const pendingNudgeId = await repository.insertPendingNudge(userId, chosen.kind, nudge, now);

  const devices = await repository.listDevices(userId);
  let pushed = false;
  for (const device of devices) {
    const outcome = await deps.push(
      device,
      { title: nudge.title, body: nudge.body },
      { type: 'coach_nudge', id: pendingNudgeId, deepLink: `vital://coach-nudge/${pendingNudgeId}` },
    );
    if (outcome.outcome === 'sent') pushed = true;
  }
  if (pushed) await repository.markNudgeSent(pendingNudgeId, now);

  return { delivered: true, pendingNudgeId, kind: chosen.kind, pushed };
}
