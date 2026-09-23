import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * Drives the real calculate_macros executeToolCall path against a fake
 * `@/db` (calculate_macros's only DB dependency is readCoreProfile's
 * `users.core_profile_md` lookup — no workouts/weight tables involved, since
 * weight comes from the tool's own `weightKg` input or the profile, and
 * `todayWorkouts` comes straight from the tool input). Same mocking
 * constraint as lib/brain/dietBudget.test.ts: `@/db` must be mocked before
 * `./tools` is first imported.
 */
const state: { coreProfileMd: string | null } = { coreProfileMd: null };

const fakeDb = {
  select: (proj: Record<string, unknown>) => {
    if ('core_profile_md' in proj) {
      return { from: () => ({ where: () => ({ limit: async () => [{ core_profile_md: state.coreProfileMd }] }) }) };
    }
    throw new Error(`unexpected projection in select(): ${JSON.stringify(proj)}`);
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const toolsPromise = import('./tools');

function coreProfile(opts: { age: number; sex: string; heightCm: number; weightKg: number }): string {
  return [
    '## Identity',
    `- Age: ${opts.age}`,
    `- Sex: ${opts.sex}`,
    `- Height: ${opts.heightCm} cm`,
    `- Current weight: ${opts.weightKg} kg — last updated 2026-08-01`,
    '',
  ].join('\n');
}

test('calculate_macros floors a below-floor target and reports lowEnergyWarning', async () => {
  const { executeToolCall } = await toolsPromise;
  // Small/older/female cut — same profile dietBudget.test.ts uses to hit the floor.
  state.coreProfileMd = coreProfile({ age: 65, sex: 'female', heightCm: 150, weightKg: 45 });

  const raw = await executeToolCall('calculate_macros', { goal: 'weight_loss' }, 'user-1');
  const result = JSON.parse(raw);

  assert.equal(result.targetCal, 1200, 'must be clamped to the female low-energy floor');
  assert.equal(result.lowEnergyWarning?.appliedFloor, true);
  assert.equal(result.lowEnergyWarning?.thresholdKcal, 1200);
  // Macros must be re-split off the floored kcal, not the original unfloored one.
  assert.equal(result.macros.c + result.macros.p + result.macros.f > 0, true);
});

test('calculate_macros returns lowEnergyWarning: null when the target clears the floor', async () => {
  const { executeToolCall } = await toolsPromise;
  state.coreProfileMd = coreProfile({ age: 30, sex: 'male', heightCm: 180, weightKg: 80 });

  const raw = await executeToolCall('calculate_macros', { goal: 'general' }, 'user-1');
  const result = JSON.parse(raw);

  assert.equal(result.lowEnergyWarning, null);
  assert.ok(result.targetCal > 1500);
});

test('calculate_macros keeps single-day semantics: todayWorkouts kcal is added in full, not averaged', async () => {
  const { executeToolCall } = await toolsPromise;
  state.coreProfileMd = coreProfile({ age: 30, sex: 'male', heightCm: 180, weightKg: 80 });

  const noWorkouts = JSON.parse(await executeToolCall('calculate_macros', { goal: 'general' }, 'user-1'));
  const withWorkout = JSON.parse(await executeToolCall(
    'calculate_macros',
    { goal: 'general', todayWorkouts: [{ type: 'run', calories: 400 }] },
    'user-1',
  ));

  // A single day's 400 kcal workout must add the FULL 400 kcal to that
  // day's TDEE (windowDays defaults to 1) — this is the pre-existing,
  // still-correct single-day behavior that the multi-day averaging fix for
  // computeAutoBudget (dietBudget.ts) must not disturb.
  assert.equal(withWorkout.tdee - noWorkouts.tdee, 400);
});
