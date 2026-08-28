import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  RUNNING_COACH_TOOL_ALLOWLIST,
  SpecialistRegistry,
  assertValidSpecialistManifest,
  type SpecialistId,
} from './registry';

// Read tool names from source text rather than importing lib/brain/tools.ts —
// that module pulls in db/index.ts, which throws without a live DATABASE_URL
// (not set under the plain `npm test` invocation).
function brainToolNames(): Set<string> {
  const source = readFileSync(path.join(__dirname, '../brain/tools.ts'), 'utf8');
  return new Set([...source.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]));
}

test('registry exposes the versioned running coach manifest', () => {
  const registry = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' });
  const manifest = registry.get('running-coach');

  assert.equal(registry.list().length, 3);
  assert.equal(manifest.id, 'running-coach');
  assert.equal(manifest.name, 'Running Coach');
  assert.equal(manifest.role, 'Vital Specialist');
  assert.equal(manifest.accentColor, '#4CC9F0');
  assert.match(manifest.icon, /run/i);
  assert.equal(manifest.model, 'claude-specialist-test');
  assert.ok(manifest.version.length > 0);
  assert.ok(manifest.triggerDescription.length <= 160);
  assert.deepEqual(manifest.promptModules.map((module) => module.id), ['running', 'recovery']);
});

test('running coach is restricted to health reads and confirmation-gated memory', () => {
  const manifest = new SpecialistRegistry({ SPECIALIST_MODEL: 'test-model' }).get('running-coach');

  assert.deepEqual(manifest.allowedTools, RUNNING_COACH_TOOL_ALLOWLIST);
  assert.deepEqual(manifest.allowedTools, [
    'get_metric_trend',
    'get_sleep_summary',
    'get_workouts',
    'get_baseline',
    'compare_periods',
    'propose_fact',
    'confirm_fact',
  ]);
  assert.ok(!manifest.allowedTools.includes('remember_fact'));
  assert.ok(!manifest.allowedTools.includes('log_meal'));
  assert.ok(!manifest.allowedTools.includes('update_diet_budget'));
});

test('manifest validation rejects inconsistent identity and capabilities', () => {
  const valid = new SpecialistRegistry({ SPECIALIST_MODEL: 'test-model' }).get('running-coach');

  assert.throws(
    () => assertValidSpecialistManifest({ ...valid, accentColor: 'cyan' }),
    /accent color/,
  );
  assert.throws(
    () => assertValidSpecialistManifest({
      ...valid,
      allowedTools: ['get_workouts', 'get_workouts'],
    }),
    /duplicate tool/,
  );
  assert.throws(
    () => assertValidSpecialistManifest({ ...valid, promptModules: [] }),
    /prompt module/,
  );
});

test('registry rejects unknown specialist ids and requires SPECIALIST_MODEL', () => {
  assert.throws(
    () => new SpecialistRegistry({}).get('running-coach'),
    /SPECIALIST_MODEL/,
  );
  assert.throws(
    () => new SpecialistRegistry({ SPECIALIST_MODEL: 'test-model' }).get('unknown'),
    /Unknown specialist: unknown/,
  );
});

test('registry lists all three specialists and resolves each by id', () => {
  const registry = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' });

  const manifests = registry.list();
  assert.equal(manifests.length, 3);
  assert.deepEqual(
    manifests.map((manifest) => manifest.id).sort(),
    ['nutritionist', 'running-coach', 'strength-coach'],
  );

  const nutritionist = registry.get('nutritionist');
  assert.equal(nutritionist.name, 'Nutritionist');
  assert.equal(nutritionist.role, 'Vital Specialist');
  assert.equal(nutritionist.accentColor, '#57CC99');
  assert.equal(nutritionist.icon, 'fork.knife');

  const strengthCoach = registry.get('strength-coach');
  assert.equal(strengthCoach.name, 'Strength Coach');
  assert.equal(strengthCoach.role, 'Vital Specialist');
  assert.equal(strengthCoach.accentColor, '#F4A261');
  assert.equal(strengthCoach.icon, 'dumbbell.fill');
});

test('every specialist manifest passes validation', () => {
  const registry = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' });
  for (const manifest of registry.list()) {
    assert.doesNotThrow(() => assertValidSpecialistManifest(manifest));
  }
});

test('every allowlisted tool exists in lib/brain/tools.ts', () => {
  const registry = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' });
  const knownToolNames = brainToolNames();
  for (const manifest of registry.list()) {
    for (const toolName of manifest.allowedTools) {
      assert.ok(
        knownToolNames.has(toolName),
        `${manifest.id} allowlists unknown tool ${toolName}`,
      );
    }
  }
});

test('nutritionist and strength coach trigger descriptions are disjoint from running coach', () => {
  const registry = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' });
  const [runningCoach, nutritionist, strengthCoach] = (
    ['running-coach', 'nutritionist', 'strength-coach'] as SpecialistId[]
  ).map((id) => registry.get(id));

  assert.notEqual(runningCoach.triggerDescription, nutritionist.triggerDescription);
  assert.notEqual(runningCoach.triggerDescription, strengthCoach.triggerDescription);
  assert.notEqual(nutritionist.triggerDescription, strengthCoach.triggerDescription);
});

test('nutritionist prompt requires explicit agreement before changing the diet budget', () => {
  const nutritionist = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' }).get('nutritionist');
  const dietBudgetModule = nutritionist.promptModules.find((module) => module.id === 'diet-budget');
  assert.ok(dietBudgetModule);
  assert.match(dietBudgetModule!.prompt, /source of truth/);
  assert.match(dietBudgetModule!.prompt, /update_diet_budget/);
  assert.match(dietBudgetModule!.prompt, /explicit agreement/);
});

test('strength coach prompt discloses the no sets/reps/load data limitation', () => {
  const strengthCoach = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' }).get('strength-coach');
  const strengthModule = strengthCoach.promptModules.find((module) => module.id === 'strength');
  assert.ok(strengthModule);
  assert.match(strengthModule!.prompt, /no sets, reps, or load/);
  assert.match(strengthModule!.prompt, /workout_completed/);
  assert.ok(!strengthCoach.allowedTools.includes('update_diet_budget'));
});
