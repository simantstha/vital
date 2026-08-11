import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * resolve_fact retracts a confirmed ontology node (status: 'active' -> 'resolved')
 * instead of the coach inserting a second node or telling the user a
 * nonexistent "ontology team" would handle it. Mirrors the
 * PendingFactConfirmationStore fake-store test style in
 * lib/brain/tools.specialist.test.ts — resolveFact() takes an injectable
 * NodeResolutionStore so this never touches Postgres.
 */

test('resolve_fact resolves a matching active node by label and returns what was resolved', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { resolveFact } = await import('./tools');

  const findCalls: Array<Record<string, unknown>> = [];
  const resolveCalls: Array<Record<string, unknown>> = [];
  const store = {
    async findActiveNode(request: { userId: string; id: string | null; label: string | null }) {
      findCalls.push(request);
      if (request.userId === 'user-1' && request.label?.toLowerCase() === 'adductor injury') {
        return { id: 'node-1', label: 'Adductor injury', type: 'Injury' };
      }
      return null;
    },
    async resolveNode(request: { id: string; userId: string; resolvedAt: Date }) {
      resolveCalls.push(request);
      return { id: 'node-1', label: 'Adductor injury', type: 'Injury' };
    },
  };

  const result = await resolveFact(
    store,
    { label: 'Adductor Injury', evidence: 'my adductor injury is fully healed' },
    'user-1',
    new Date('2026-08-11T12:00:00.000Z'),
  );

  assert.deepEqual(findCalls, [{ userId: 'user-1', id: null, label: 'Adductor Injury' }]);
  assert.deepEqual(resolveCalls, [{ id: 'node-1', userId: 'user-1', resolvedAt: new Date('2026-08-11T12:00:00.000Z') }]);
  assert.deepEqual(result, {
    ok: true,
    resolved: true,
    nodeId: 'node-1',
    label: 'Adductor injury',
    nodeType: 'Injury',
    evidence: 'my adductor injury is fully healed',
  });
});

test('resolve_fact is scoped to the requesting user and never resolves another user\'s fact', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { resolveFact } = await import('./tools');

  const resolveCalls: Array<Record<string, unknown>> = [];
  const store = {
    async findActiveNode(request: { userId: string; id: string | null; label: string | null }) {
      // Simulates the DB scoping: the same label exists for a different user,
      // but the store only ever returns a match for the owning user_id.
      if (request.userId !== 'user-owner') return null;
      return { id: 'node-owner', label: 'Peanut allergy', type: 'Allergy' };
    },
    async resolveNode(request: { id: string; userId: string; resolvedAt: Date }) {
      resolveCalls.push(request);
      return { id: request.id, label: 'Peanut allergy', type: 'Allergy' };
    },
  };

  const forOwner = await resolveFact(store, { label: 'Peanut allergy', evidence: 'outgrew it' }, 'user-owner');
  const forOther = await resolveFact(store, { label: 'Peanut allergy', evidence: 'outgrew it' }, 'user-other');

  assert.equal(forOwner.ok, true);
  assert.equal(forOther.ok, false);
  assert.deepEqual(resolveCalls, [{ id: 'node-owner', userId: 'user-owner', resolvedAt: resolveCalls[0].resolvedAt }]);
  assert.equal(resolveCalls.length, 1, 'must never call resolveNode for the non-owning user');
});

test('resolve_fact is idempotent: a second call on an already-resolved fact does not throw or double-resolve', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { resolveFact } = await import('./tools');

  // Simulates the real drizzleNodeResolutionStore: findActiveNode filters on
  // status = 'active', so once a node is resolved it stops matching.
  let resolved = false;
  const resolveCalls: Array<Record<string, unknown>> = [];
  const store = {
    async findActiveNode() {
      return resolved ? null : { id: 'node-1', label: 'Marathon taper', type: 'Goal' };
    },
    async resolveNode(request: { id: string; userId: string; resolvedAt: Date }) {
      resolveCalls.push(request);
      resolved = true;
      return { id: 'node-1', label: 'Marathon taper', type: 'Goal' };
    },
  };

  const first = await resolveFact(store, { label: 'Marathon taper', evidence: 'race is over' }, 'user-1');
  const second = await resolveFact(store, { label: 'Marathon taper', evidence: 'race is over' }, 'user-1');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /no matching active fact/i);
  assert.equal(resolveCalls.length, 1, 'resolveNode must only ever run once for the same fact');
});

test('resolve_fact returns a clear no-match result instead of throwing when nothing matches', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { resolveFact } = await import('./tools');

  let resolveNodeCalled = false;
  const store = {
    async findActiveNode() { return null; },
    async resolveNode() { resolveNodeCalled = true; return null; },
  };

  const result = await resolveFact(store, { label: 'Broken leg', evidence: 'never happened' }, 'user-1');

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no matching active fact.*"broken leg"/i);
  assert.equal(resolveNodeCalled, false);
});

test('resolve_fact rejects a call with neither label nor id without touching the store', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { resolveFact } = await import('./tools');

  let findCalled = false;
  const store = {
    async findActiveNode() { findCalled = true; return null; },
    async resolveNode() { return null; },
  };

  const result = await resolveFact(store, { evidence: 'no label or id given' }, 'user-1');

  assert.equal(result.ok, false);
  assert.equal(findCalled, false);
});

test('resolve_fact is registered as a BRAIN_TOOLS definition and dispatched by executeToolCall', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const tools = await import('./tools');

  const definition = tools.BRAIN_TOOLS.find((tool) => tool.name === 'resolve_fact');
  assert.ok(definition, 'resolve_fact must be registered in BRAIN_TOOLS');
  assert.match(String(definition!.description), /retract/i);

  const missingEvidence = await tools.executeToolCall('resolve_fact', { label: 'Adductor injury' }, 'user-1');
  assert.match(missingEvidence, /evidence is required/i);
});
