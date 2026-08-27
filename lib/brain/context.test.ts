import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

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
