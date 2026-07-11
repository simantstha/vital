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

test('fact confirmation scopes atomic resolution to owner and pending status', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { confirmPendingFact } = await import('./tools');
  const promoted: Array<{ userId: string; node: Record<string, unknown> }> = [];
  const requests: Array<Record<string, unknown>> = [];
  const store = {
    async resolvePendingFact(request: Record<string, unknown>) {
      requests.push(request);
      if (request.factId !== 'fact-owner' || request.userId !== 'user-owner' ||
          request.expectedStatus !== 'pending') return null;
      return {
        id: 'fact-owner',
        proposedNode: { type: 'Goal', label: 'Run a 10K', properties: null },
      };
    },
    async insertConfirmedNode(userId: string, node: Record<string, unknown>) {
      promoted.push({ userId, node });
    },
  };

  const result = await confirmPendingFact(
    store,
    { factId: 'fact-owner', action: 'confirm' },
    'user-owner',
    new Date('2026-07-11T12:00:00.000Z'),
  );

  assert.deepEqual(requests, [{
    factId: 'fact-owner',
    userId: 'user-owner',
    expectedStatus: 'pending',
    nextStatus: 'confirmed',
    resolvedAt: new Date('2026-07-11T12:00:00.000Z'),
  }]);
  assert.deepEqual(promoted, [{
    userId: 'user-owner',
    node: { type: 'Goal', label: 'Run a 10K', properties: null },
  }]);
  assert.deepEqual(result, { ok: true, factId: 'fact-owner', status: 'confirmed' });
});

test('fact confirmation cannot resolve or promote cross-user and terminal facts', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { confirmPendingFact } = await import('./tools');
  let promotions = 0;
  const store = {
    async resolvePendingFact() { return null; },
    async insertConfirmedNode() { promotions += 1; },
  };

  for (const factId of ['other-users-fact', 'already-confirmed-fact', 'already-rejected-fact']) {
    const result = await confirmPendingFact(
      store,
      { factId, action: 'confirm' },
      'user-owner',
      new Date('2026-07-11T12:00:00.000Z'),
    );
    assert.deepEqual(result, { ok: false, factId, error: 'pending_fact_not_found' });
  }
  assert.equal(promotions, 0);
});

test('rejecting an owned pending fact never promotes it', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { confirmPendingFact } = await import('./tools');
  let promotions = 0;
  const store = {
    async resolvePendingFact() {
      return { id: 'fact-owner', proposedNode: { type: 'Goal', label: 'Run a 10K' } };
    },
    async insertConfirmedNode() { promotions += 1; },
  };

  const result = await confirmPendingFact(
    store,
    { factId: 'fact-owner', action: 'reject' },
    'user-owner',
    new Date('2026-07-11T12:00:00.000Z'),
  );
  assert.deepEqual(result, { ok: true, factId: 'fact-owner', status: 'rejected' });
  assert.equal(promotions, 0);
});
