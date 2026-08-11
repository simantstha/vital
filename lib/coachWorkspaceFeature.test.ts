import assert from 'node:assert/strict';
import test from 'node:test';
import { isCoachWorkspaceEnabled } from './coachWorkspaceFeature';

test('Coach Workspace flag is disabled by default and requires literal true', () => {
  assert.equal(isCoachWorkspaceEnabled({}), false);
  assert.equal(isCoachWorkspaceEnabled({ COACH_WORKSPACE_V1: 'false' }), false);
  assert.equal(isCoachWorkspaceEnabled({ COACH_WORKSPACE_V1: '1' }), false);
  assert.equal(isCoachWorkspaceEnabled({ COACH_WORKSPACE_V1: 'TRUE' }), false);
  assert.equal(isCoachWorkspaceEnabled({ COACH_WORKSPACE_V1: 'true' }), true);
});
