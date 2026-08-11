import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjustmentWithMaterialSignature,
  assertActionAllowedForRecommendation,
  deriveCoachWorkspaceState,
  materialSignatureFromAdjustment,
  shouldMutatePlanForAction,
  type HydrationInteraction,
} from './coachWorkspaceState';

const baseAction = {
  title: 'Keep training comfortable', copy: 'Safe deterministic copy.', kind: 'move' as const,
  timeMinutes: 1020, durationMinutes: 45, intensity: 'easy' as const,
};

function interaction(overrides: Partial<HydrationInteraction>): HydrationInteraction {
  return {
    action: 'accept', adjustment: null, planItemId: 'plan-1',
    materialSignature: 'signature-current',
    createdAt: new Date('2026-08-11T15:00:00Z'), ...overrides,
  };
}

test('interaction material context round-trips through adjustment JSONB', () => {
  const stored = adjustmentWithMaterialSignature({ durationMinutes: 30 }, 'signature-current');

  assert.deepEqual(stored, { durationMinutes: 30, __materialSignature: 'signature-current' });
  assert.equal(materialSignatureFromAdjustment(stored), 'signature-current');
  assert.equal(materialSignatureFromAdjustment({ durationMinutes: 30 }), null);
});

test('calibration always hydrates as calibration without a plan', () => {
  const state = deriveCoachWorkspaceState({
    category: 'calibration', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    materialSignature: 'signature-current',
    interactions: [interaction({ action: 'accept' })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending', kind: 'move' },
  });

  assert.deepEqual(state, { status: 'calibration', planItemId: null, effectiveAction: baseAction });
});

test('accept followed by open_chat hydrates the accepted plan as planned', () => {
  const state = deriveCoachWorkspaceState({
    category: 'training', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    materialSignature: 'signature-current',
    interactions: [
      interaction({ action: 'open_chat', planItemId: null, createdAt: new Date('2026-08-11T16:00:00Z') }),
      interaction({ action: 'accept' }),
    ],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending', kind: 'move' },
  });

  assert.deepEqual(state, { status: 'planned', planItemId: 'plan-1', effectiveAction: baseAction });
});

test('adjusted action is reconstructed on reload', () => {
  const state = deriveCoachWorkspaceState({
    category: 'training', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    materialSignature: 'signature-current',
    interactions: [interaction({
      action: 'adjust', adjustment: { timeMinutes: 1080, durationMinutes: 30, intensity: 'moderate' },
    })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending', kind: 'move' },
  });

  assert.deepEqual(state.effectiveAction, {
    ...baseAction, timeMinutes: 1080, durationMinutes: 30, intensity: 'moderate',
  });
  assert.equal(state.status, 'planned');
});

test('skipped and completed plan rows hydrate their terminal states', () => {
  for (const [action, planStatus, expected] of [
    ['skip', 'skipped', 'skipped'], ['complete', 'done', 'completed'],
  ] as const) {
    const state = deriveCoachWorkspaceState({
      category: 'training', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
      materialSignature: 'signature-current',
      interactions: [interaction({ action })],
      planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: planStatus, kind: 'move' },
    });
    assert.equal(state.status, expected);
    assert.equal(state.planItemId, 'plan-1');
  }
});

test('a linked plan from another day is never hydrated', () => {
  const state = deriveCoachWorkspaceState({
    category: 'training', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    materialSignature: 'signature-current',
    interactions: [interaction({ action: 'accept' })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-10', status: 'pending', kind: 'move' },
  });

  assert.deepEqual(state, { status: 'ready', planItemId: null, effectiveAction: baseAction });
});

test('historical adjustment from an incompatible action kind falls back to current ready state', () => {
  const sleepAction = {
    title: 'Protect sleep', copy: 'Wind down earlier.', kind: 'sleep' as const,
    timeMinutes: 1290, durationMinutes: null, intensity: null,
  };
  const state = deriveCoachWorkspaceState({
    category: 'sleep', action: sleepAction, materialSignature: 'signature-new',
    userId: 'user-1', localDay: '2026-08-11',
    interactions: [interaction({
      action: 'adjust', materialSignature: null,
      adjustment: { durationMinutes: 45, intensity: 'moderate' },
    })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending', kind: 'move' },
  });

  assert.deepEqual(state, { status: 'ready', planItemId: null, effectiveAction: sleepAction });
});

test('interaction from an older material signature does not hydrate against current action', () => {
  const state = deriveCoachWorkspaceState({
    category: 'training', action: baseAction, materialSignature: 'signature-new',
    userId: 'user-1', localDay: '2026-08-11',
    interactions: [interaction({ action: 'accept', materialSignature: 'signature-old' })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending', kind: 'move' },
  });

  assert.deepEqual(state, { status: 'ready', planItemId: null, effectiveAction: baseAction });
});

test('calibration rejects plan-mutating actions but permits skip and open_chat', () => {
  for (const action of ['accept', 'adjust', 'complete'] as const) {
    assert.throws(() => assertActionAllowedForRecommendation('calibration', action), /not allowed/);
  }
  assert.doesNotThrow(() => assertActionAllowedForRecommendation('calibration', 'skip'));
  assert.doesNotThrow(() => assertActionAllowedForRecommendation('calibration', 'open_chat'));
  assert.equal(shouldMutatePlanForAction('calibration', 'skip'), false);
  assert.equal(shouldMutatePlanForAction('training', 'skip'), true);
});
