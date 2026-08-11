import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertActionAllowedForRecommendation,
  deriveCoachWorkspaceState,
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
    createdAt: new Date('2026-08-11T15:00:00Z'), ...overrides,
  };
}

test('calibration always hydrates as calibration without a plan', () => {
  const state = deriveCoachWorkspaceState({
    category: 'calibration', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    interactions: [interaction({ action: 'accept' })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending' },
  });

  assert.deepEqual(state, { status: 'calibration', planItemId: null, effectiveAction: baseAction });
});

test('accept followed by open_chat hydrates the accepted plan as planned', () => {
  const state = deriveCoachWorkspaceState({
    category: 'training', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    interactions: [
      interaction({ action: 'open_chat', planItemId: null, createdAt: new Date('2026-08-11T16:00:00Z') }),
      interaction({ action: 'accept' }),
    ],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending' },
  });

  assert.deepEqual(state, { status: 'planned', planItemId: 'plan-1', effectiveAction: baseAction });
});

test('adjusted action is reconstructed on reload', () => {
  const state = deriveCoachWorkspaceState({
    category: 'training', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    interactions: [interaction({
      action: 'adjust', adjustment: { timeMinutes: 1080, durationMinutes: 30, intensity: 'moderate' },
    })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: 'pending' },
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
      interactions: [interaction({ action })],
      planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-11', status: planStatus },
    });
    assert.equal(state.status, expected);
    assert.equal(state.planItemId, 'plan-1');
  }
});

test('a linked plan from another day is never hydrated', () => {
  const state = deriveCoachWorkspaceState({
    category: 'training', action: baseAction, userId: 'user-1', localDay: '2026-08-11',
    interactions: [interaction({ action: 'accept' })],
    planItem: { id: 'plan-1', userId: 'user-1', localDay: '2026-08-10', status: 'pending' },
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
