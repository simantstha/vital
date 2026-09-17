import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * resolveFact's cascade (migration 0028, nodes.subject_node_id): resolving an
 * entity (e.g. "Father") must also resolve every fact scoped to it via
 * subject_node_id, in the SAME transaction — otherwise those facts are left
 * active-but-subjectless the instant their subject disappears (the coach
 * would keep believing "Father has diabetes" with no father on record).
 *
 * This drives the real drizzleNodeResolutionStore.resolveNode (reached only
 * through the exported resolve_fact tool path — the store itself isn't
 * exported) against a fake `@/db` and inspects both update() calls made
 * inside db.transaction(). Serializing the drizzle SQL AST and checking for
 * the "subject_node_id" identifier mirrors
 * proactiveHealthWorkerRepositoryOntologyStatus.test.ts's technique for
 * proving a WHERE clause, not just a query, exists.
 *
 * `@/db` must be mocked before `./tools` is first imported in this process,
 * so this lives in its own file — node:test runs each test file in its own
 * subprocess (same reasoning as the ontology-status test).
 */
test('resolving an entity cascades to resolve every active fact whose subject_node_id points at it, in one transaction', async () => {
  const updateWhereConditions: unknown[] = [];
  let selectCalled = false;

  const fakeTx = {
    update: (table: unknown) => {
      assert.equal(table, realSchema.nodes, 'cascade must operate on the nodes table');
      return {
        set: (values: Record<string, unknown>) => {
          assert.equal(values.status, 'resolved');
          return {
            where: (condition: unknown) => {
              updateWhereConditions.push(condition);
              // The first update (target lookup by id) chains .returning();
              // the cascade update is awaited directly with no .returning().
              // Attaching .returning() onto the same resolved-array promise
              // satisfies both call shapes without needing to track order.
              const result = Promise.resolve([]) as unknown as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
              result.returning = async () => [{ id: 'father-entity', label: 'Father', type: 'Person' }];
              return result;
            },
          };
        },
      };
    },
  };

  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        assert.equal(table, realSchema.nodes);
        selectCalled = true;
        // findActiveNode's label lookup — resolves "Father" to the entity.
        return { where: async () => [{ id: 'father-entity', label: 'Father', type: 'Person' }] };
      },
    }),
    transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
  };

  mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
  const tools = await import('./tools');

  const result = await tools.executeToolCall('resolve_fact', { label: 'Father', evidence: 'he passed away' }, 'user-1');
  const parsed = JSON.parse(result);

  assert.ok(selectCalled, 'must look up the active node by label first');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nodeId, 'father-entity');

  assert.equal(updateWhereConditions.length, 2, 'must issue exactly two updates: the target, then the cascade');

  const serialize = (c: unknown) => JSON.stringify(c, (key, value) => (key === 'table' ? '[table]' : value));
  const [targetCondition, cascadeCondition] = updateWhereConditions.map(serialize);

  // The target update matches by id, not by subject_node_id.
  assert.doesNotMatch(targetCondition, /"name":"subject_node_id"/);
  assert.match(targetCondition, /"name":"id"/);

  // The cascade update matches every active fact whose subject_node_id is
  // the just-resolved entity's id, scoped to the same user.
  assert.match(cascadeCondition, /"name":"subject_node_id"/);
  assert.match(cascadeCondition, /"value":"father-entity"/);
  assert.match(cascadeCondition, /"name":"status"/);
  assert.match(cascadeCondition, /"value":"active"/);
});
