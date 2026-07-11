import assert from 'node:assert/strict';
import test from 'node:test';

test('specialist fact proposal tool only constructs a pending fact', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const tools = await import('./tools');
  const definition = tools.BRAIN_TOOLS.find((tool) => tool.name === 'propose_fact');

  assert.ok(definition);
  assert.match(String(definition.description), /confirm/i);
  assert.equal(typeof tools.buildPendingFactProposal, 'function');
  assert.deepEqual(tools.buildPendingFactProposal({
    nodeType: 'Goal',
    label: 'Run a 10K',
    evidence: 'I want to run a 10K this fall.',
  }, '00000000-0000-4000-8000-000000000001'), {
    user_id: '00000000-0000-4000-8000-000000000001',
    proposed_node: {
      type: 'Goal',
      label: 'Run a 10K',
      properties: { evidence: 'I want to run a 10K this fall.' },
    },
    proposed_edge: null,
    evidence: 'I want to run a 10K this fall.',
    salience: 0.6,
    status: 'pending',
  });
});
