import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { WeightSignal } from './weightSignals';

/**
 * lib/brain/context.ts imports `@/db` at module load time (directly, and
 * transitively via ./tools), so even exercising the pure, DB-free
 * `buildPromptText` half requires `@/db` mocked before the module is first
 * imported — same constraint as lib/brain/brief.test.ts and
 * lib/proactiveHealthWorkerRepository.test.ts. `buildPromptText` never calls
 * the fake below; it's only here to satisfy the top-level import.
 *
 * Testing `buildPromptText` directly (rather than the full `assembleContext`)
 * avoids mocking the ~8 different queries assembleContext fans out to
 * (users/events/nodes/messages/baselines/calibration/schedule/daily_metrics),
 * none of which are relevant to the unit-formatting behavior under test here.
 *
 * Highest-value case per the units rollout: an imperial user's prompt must
 * render weight in lb and workout distance in mi; a metric user's prompt
 * must be byte-for-byte the same as before this feature.
 */

mock.module('@/db', {
  namedExports: {
    db: new Proxy({}, { get() { throw new Error('buildPromptText must not touch the DB'); } }),
    schema: {},
  },
});

const contextPromise = import('./context');

function baseCtx(unitSystem: 'metric' | 'imperial') {
  return {
    userId: 'user-1',
    today: {
      date: '2026-08-04',
      weight: 81.2 as number | undefined, // kg — 81.2 * 2.2046226218 ≈ 179.0 lb
      workouts: [
        { type: 'running', distanceM: 8437, durationS: 2700, avgHr: 148, calories: 412 },
      ] as Array<{ type: string; distanceM?: number; durationS?: number; avgHr?: number; calories?: number }>,
      meals: [],
    },
    localNow: 'Tuesday, August 4, 2026, 2:00 PM CDT',
    timezone: 'America/Chicago',
    schedule: [],
    recentMessages: [],
    hardConstraints: [],
    softFacts: [],
    baselines: [],
    calibration: { status: 'ready' as const, metrics: {} },
    unitSystem,
    entityRoster: [],
    weightSignals: [] as WeightSignal[],
  };
}

test('imperial unitSystem renders weight in lb and workout distance in mi', async () => {
  const { buildPromptText } = await contextPromise;
  const text = buildPromptText(baseCtx('imperial') as Parameters<typeof buildPromptText>[0]);

  assert.match(text, /- Weight: 179 lb/);
  assert.match(text, /Workout: running 5\.2 mi/);
  assert.doesNotMatch(text, /\bkg\b/);
  assert.doesNotMatch(text, /\bkm\b/);
});

test('metric unitSystem (default) renders weight in kg and workout distance in km — unchanged from before the units feature', async () => {
  const { buildPromptText } = await contextPromise;
  const text = buildPromptText(baseCtx('metric') as Parameters<typeof buildPromptText>[0]);

  assert.match(text, /- Weight: 81\.2 kg/);
  assert.match(text, /Workout: running 8\.4 km/);
  assert.doesNotMatch(text, /\blb\b/);
  assert.doesNotMatch(text, /\bmi\b/);
});

test('a missing weight/distance omits those lines regardless of unitSystem', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('imperial');
  ctx.today.weight = undefined;
  ctx.today.workouts = [{ type: 'strength', durationS: 1800 }];

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.doesNotMatch(text, /- Weight:/);
  assert.match(text, /Workout: strength 30min/);
});

test('a diet budget with a lowEnergyWarning emits a SAFETY line the coach can explain', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  (ctx as Record<string, unknown>).dietBudget = {
    mode: 'auto', goal: 'weight_loss', targetKcal: 1200, protein: 130, carbs: 90, fat: 40, tdee: 1600,
    lowEnergyWarning: { thresholdKcal: 1200, appliedFloor: true, message: 'eased the deficit' },
  };

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.match(text, /SAFETY: target is at\/below the ~1200 kcal low-energy-availability floor\./);
  assert.match(text, /We raised the target to this floor rather than cut further/);
});

test('a diet budget with no lowEnergyWarning omits the SAFETY line', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  (ctx as Record<string, unknown>).dietBudget = {
    mode: 'auto', goal: 'general', targetKcal: 2400, protein: 150, carbs: 250, fat: 80, tdee: 2400,
    lowEnergyWarning: null,
  };

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.doesNotMatch(text, /SAFETY:/);
});

// ── Weight trend & energy signals section ───────────────────────────────

test('an established trend with span >= 7 renders trend weight + rate, plus one line per signal', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  // 22 daily weigh-ins falling 0.9 kg/wk, the newest on 2026-08-04: the rate is the pace of the raw weigh-ins (lib/weightPace.ts).
  const start = Date.UTC(2026, 6, 14);
  const days = Array.from({ length: 22 }, (_, i) => {
    const kg = Math.round((82.4 - (0.9 / 7) * i) * 100) / 100;
    return { day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), rawKg: kg, trendKg: kg };
  });
  (ctx as Record<string, unknown>).weightTrend = { established: true, days, delta7dKgPerWeek: -1.3, delta30dKgPerWeek: -1.1 };
  (ctx as Record<string, unknown>).localToday = '2026-08-04';
  (ctx as Record<string, unknown>).weightSignals = [
    { kind: 'too_fast_loss', severity: 'watch', facts: { rateKgPerWeek: -1.3, pctPerWeek: 1.6 } },
  ];

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.match(text, /### Weight trend & energy signals/);
  assert.match(text, /- Trend weight: 79\.7 kg \(0\.9 kg\/wk loss\)/);
  assert.match(text, /- \[WATCH\] Losing faster than recommended: rateKgPerWeek=-1\.3, pctPerWeek=1\.6/);
});

test('a fat-loss goal card replaces the smoothed trend line with its weekly average and the week\'s pace (one displayed weight)', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  const start = Date.UTC(2026, 6, 14);
  const days = Array.from({ length: 22 }, (_, i) => {
    const kg = Math.round((82.4 - (0.9 / 7) * i) * 100) / 100;
    return { day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), rawKg: kg, trendKg: kg };
  });
  (ctx as Record<string, unknown>).weightTrend = { established: true, days, delta7dKgPerWeek: -1.3, delta30dKgPerWeek: -1.1 };
  (ctx as Record<string, unknown>).localToday = '2026-08-04';
  (ctx as Record<string, unknown>).weightSignals = [];
  // Only the fields the weight line reads; formatGoalProgressLines is not under test here.
  (ctx as Record<string, unknown>).goalProgress = {
    goal: 'weight_loss',
    target: { weightKg: 76, date: null, weeklySessions: null, weeklyDistanceKm: null },
    distance: null,
    current: { weightKg: 79.9, trendKg: 79.7, startWeightKg: 82.4, changeKg: -2.5, progressPct: 30 },
    ratePerWeek: { kg: null, pctBodyweight: null },
    eta: null,
    onPaceForTargetDate: null,
    verdict: 'progressing',
    headline: 'Progressing — losing about 0.47 kg a week',
    reasons: [],
    weightRead: { weekMeanKg: 79.9, scaleKg: 79.6, plan: { state: 'pace', pace: { kgPerWeek: -0.47 }, action: { kind: 'keep_going', text: 'Keep your routine — it is working' }, weekStart: '2026-08-03' } },
    dataSufficiency: { weighIns: 22, needed: 3, sessionsLast28d: 0 },
  };

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.match(text, /- Weekly average weight: 79\.9 kg \(0\.47 kg\/wk loss\)/);
  assert.doesNotMatch(text, /- Trend weight:/);
});

test('a weigh-in more than a week old is never the source of a quoted weekly rate', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  const start = Date.UTC(2026, 6, 14);
  const days = Array.from({ length: 22 }, (_, i) => {
    const kg = Math.round((82.4 - (0.9 / 7) * i) * 100) / 100;
    return { day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), rawKg: kg, trendKg: kg };
  });
  (ctx as Record<string, unknown>).weightTrend = { established: true, days, delta7dKgPerWeek: -0.9, delta30dKgPerWeek: -0.9 };
  (ctx as Record<string, unknown>).localToday = '2026-08-13'; // newest weigh-in (08-04) is 9 days old
  (ctx as Record<string, unknown>).weightSignals = [];

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.doesNotMatch(text, /kg\/wk/);
  assert.match(text, /last weigh-in 9 days ago — do not quote a weekly rate/);
});

test('a not-yet-reliable trend tells the coach not to quote a weekly rate', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  (ctx as Record<string, unknown>).weightTrend = {
    established: true,
    days: [
      { day: '2026-08-01', rawKg: 80, trendKg: 80 },
      { day: '2026-08-06', rawKg: 79.5, trendKg: 79.7 },
    ],
    delta7dKgPerWeek: -0.4,
    delta30dKgPerWeek: null,
  };
  (ctx as Record<string, unknown>).weightSignals = [
    { kind: 'rate_not_yet_reliable', severity: 'info', facts: { spanDays: 5 } },
  ];

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.match(text, /- Trend weight: not reliable yet — do not quote a weekly rate\./);
  assert.match(text, /- \[INFO\] Not enough history yet for a reliable weekly rate: spanDays=5/);
});

test('no weightTrend at all omits the Weight trend section entirely', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);

  assert.doesNotMatch(text, /### Weight trend & energy signals/);
});

// ── Goal progress section ───────────────────────────────────────────────

test('a goalProgress renders a compact Goal progress section with the verdict and numbers in the user\'s unit', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('imperial');
  (ctx as Record<string, unknown>).goalProgress = {
    goal: 'weight_loss',
    target: { weightKg: 76, date: '2026-12-25', weeklySessions: null, weeklyDistanceKm: null },
    distance: null,
    current: { weightKg: 82.1, startWeightKg: 85, changeKg: -2.9, progressPct: 32 },
    ratePerWeek: { kg: -0.45, pctBodyweight: -0.55 },
    safeBand: { minPct: 0.25, maxPct: 1 },
    eta: '2026-12-10',
    onPaceForTargetDate: true,
    verdict: 'on_track',
    headline: 'On track — about 13 lb to go, around Dec 10',
    reasons: [{ kind: 'rate', text: 'Losing 1 lb a week', tone: 'good' }],
    dataSufficiency: { weighIns: 20, needed: 3, sessionsLast28d: 8 },
  };

  const text = buildPromptText(ctx as Parameters<typeof buildPromptText>[0]);
  const section = text.split('### Goal progress')[1]?.split('\n###')[0] ?? '';

  assert.match(text, /### Goal progress/);
  assert.match(section, /Verdict: on_track/);
  assert.match(section, /target 167\.6 lb, by 2026-12-25/);
  assert.match(section, /ETA 2026-12-10/);
  assert.ok(section.trim().split('\n').length <= 12);
});

test('no goalProgress omits the Goal progress section entirely', async () => {
  const { buildPromptText } = await contextPromise;
  const text = buildPromptText(baseCtx('metric') as Parameters<typeof buildPromptText>[0]);
  assert.doesNotMatch(text, /### Goal progress/);
});

test('the user\'s own Goal facts are not injected into the prompt (profile goal is canonical); other soft facts still are', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  const node = (id: string, type: string, label: string, subject: string | null = null) => ({
    id, type, label, weight: 0.8, subject_node_id: subject,
  });
  (ctx as Record<string, unknown>).softFacts = [
    node('g1', 'Goal', 'Lose 5 kg by December'),
    node('h1', 'Habit', 'Prefers running in the morning'),
  ];

  const text = buildPromptText(ctx as unknown as Parameters<typeof buildPromptText>[0]);

  assert.doesNotMatch(text, /Lose 5 kg by December/);
  assert.match(text, /Prefers running in the morning/);
});

test('a prompt whose only soft fact is a Goal omits the GOALS & PREFERENCES header', async () => {
  const { buildPromptText } = await contextPromise;
  const ctx = baseCtx('metric');
  (ctx as Record<string, unknown>).softFacts = [
    { id: 'g1', type: 'Goal', label: 'Lose 5 kg by December', weight: 0.8, subject_node_id: null },
  ];

  const text = buildPromptText(ctx as unknown as Parameters<typeof buildPromptText>[0]);

  assert.doesNotMatch(text, /GOALS & PREFERENCES/);
});
