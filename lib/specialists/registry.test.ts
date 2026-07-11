import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNNING_COACH_TOOL_ALLOWLIST,
  SpecialistRegistry,
  assertValidSpecialistManifest,
} from './registry';

test('registry exposes the versioned running coach manifest', () => {
  const registry = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-specialist-test' });
  const manifest = registry.get('running-coach');

  assert.equal(registry.list().length, 1);
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
    /Unknown specialist/,
  );
});
