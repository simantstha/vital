import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/**
 * resolveNudgeFinding() is the piece of context assembly that lets a tapped
 * coach-nudge notification ("vital://coach-nudge/<pendingNudgeId>") open the
 * chat already knowing what the coach asked about — see
 * lib/insights/nudgeWorker.ts's deepLink and lib/insights/confirmation.ts's
 * insight_findings table.
 *
 * Mirrors lib/brain/tools.resolveFact.test.ts's style: the function under
 * test takes an injectable NudgeFindingLookup store, so the SECURITY-CRITICAL
 * behaviour (a nudge id scoped to another user must be invisible) is asserted
 * by a fake store that simulates the real drizzleNudgeFindingLookup's
 * `and(eq(pending_nudges.id, findingId), eq(pending_nudges.user_id, userId))`
 * scoping — it only ever returns a row for the owning user_id, exactly like a
 * real query would. This is deliberately NOT tested through
 * context.assembleContext.test.ts's fake `@/db`: that fake's `.where()`
 * ignores the actual predicate and returns canned state unconditionally, so
 * it cannot distinguish a correctly-scoped query from an IDOR — it would pass
 * either way.
 *
 * context.ts imports `@/db` at module load time (directly, and transitively
 * via ./tools), so `@/db` must be mocked before the module is first imported
 * — same constraint as context.test.ts's buildPromptText tests. Nothing here
 * ever touches the fake db; it exists only to satisfy the top-level import.
 */

mock.module('@/db', {
  namedExports: {
    db: new Proxy({}, { get() { throw new Error('resolveNudgeFinding must not touch the DB directly — it goes through the injected store'); } }),
    schema: {},
  },
});

const contextPromise = import('./context');

test('a valid findingId belonging to the requesting user resolves the finding, effectLabel included', async () => {
  const { resolveNudgeFinding } = await contextPromise;

  const store = {
    async findPendingNudge(userId: string, findingId: string) {
      if (userId === 'user-owner' && findingId === 'nudge-1') return { signature: 'sig-abc' };
      return null;
    },
    async findLatestFinding(userId: string, signature: string) {
      if (userId === 'user-owner' && signature === 'sig-abc') {
        return { kind: 'level_shift', effectLabel: '1.4 SD below baseline', detail: { metric: 'hrv', n: 21 } };
      }
      return null;
    },
  };

  const result = await resolveNudgeFinding(store, 'user-owner', 'nudge-1');

  assert.deepEqual(result, {
    kind: 'level_shift',
    effectLabel: '1.4 SD below baseline',
    detail: { metric: 'hrv', n: 21 },
  });
});

test('a findingId belonging to another user is ignored entirely — no result, no error leak', async () => {
  const { resolveNudgeFinding } = await contextPromise;

  let findLatestFindingCalled = false;
  const store = {
    // Simulates the real query's `and(eq(id, findingId), eq(user_id, userId))`
    // scoping: the row exists (for 'user-owner'), but the requesting user here
    // is 'user-attacker' — a real scoped query returns nothing, same as this.
    async findPendingNudge(userId: string, findingId: string) {
      if (userId === 'user-owner' && findingId === 'nudge-1') return { signature: 'sig-abc' };
      return null;
    },
    async findLatestFinding(userId: string, signature: string) {
      findLatestFindingCalled = true;
      return { kind: 'level_shift', effectLabel: 'should never surface', detail: {} };
    },
  };

  const result = await resolveNudgeFinding(store, 'user-attacker', 'nudge-1');

  assert.equal(result, undefined);
  assert.equal(findLatestFindingCalled, false, 'must never look up the finding once the nudge lookup misses');
});

test('a malformed findingId degrades to a normal chat rather than failing the request', async () => {
  const { resolveNudgeFinding } = await contextPromise;

  const store = {
    async findPendingNudge(): Promise<{ signature: string } | null> {
      // Simulates a real Postgres uuid column rejecting a non-UUID string —
      // e.g. "invalid input syntax for type uuid" — thrown at the DB layer.
      throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
    },
    async findLatestFinding() { throw new Error('must not be reached'); },
  };

  const result = await resolveNudgeFinding(store, 'user-owner', 'not-a-uuid');

  assert.equal(result, undefined);
});

test('an unknown findingId (well-formed but no matching row) degrades to a normal chat', async () => {
  const { resolveNudgeFinding } = await contextPromise;

  const store = {
    async findPendingNudge() { return null; },
    async findLatestFinding() { throw new Error('must not be reached'); },
  };

  const result = await resolveNudgeFinding(store, 'user-owner', 'unknown-nudge-id');

  assert.equal(result, undefined);
});

test('an absent findingId is a no-op — the store is never queried', async () => {
  const { resolveNudgeFinding } = await contextPromise;

  let called = false;
  const store = {
    async findPendingNudge() { called = true; return null; },
    async findLatestFinding() { called = true; return null; },
  };

  const resultUndefined = await resolveNudgeFinding(store, 'user-owner', undefined);
  const resultEmpty = await resolveNudgeFinding(store, 'user-owner', '   ');

  assert.equal(resultUndefined, undefined);
  assert.equal(resultEmpty, undefined);
  assert.equal(called, false);
});

test('a pending_nudges row whose finding never made it into insight_findings degrades cleanly', async () => {
  const { resolveNudgeFinding } = await contextPromise;

  const store = {
    async findPendingNudge() { return { signature: 'sig-missing' }; },
    async findLatestFinding() { return null; },
  };

  const result = await resolveNudgeFinding(store, 'user-owner', 'nudge-1');

  assert.equal(result, undefined);
});
