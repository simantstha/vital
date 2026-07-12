import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpecialistActionRequest } from './api';

test('specialist action parser accepts only the four complete action requests', () => {
  for (const action of ['accept_handoff', 'decline_handoff', 'accept_return', 'decline_return']) {
    assert.deepEqual(parseSpecialistActionRequest({
      sessionId: '10000000-0000-4000-8000-000000000001',
      actionId: `action-${action}`,
      action,
    }), {
      sessionId: '10000000-0000-4000-8000-000000000001',
      actionId: `action-${action}`,
      action,
    });
  }
  assert.equal(parseSpecialistActionRequest({ message: 'hello' }), null);
  assert.throws(() => parseSpecialistActionRequest({ sessionId: 's', actionId: '', action: 'accept_handoff' }), /actionId/);
  assert.throws(() => parseSpecialistActionRequest({ sessionId: 's', actionId: 'a', action: 'takeover' }), /action/);
});
