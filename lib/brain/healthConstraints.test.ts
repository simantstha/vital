import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../../db/schema';

/**
 * lib/brain/healthConstraints.ts backfills Injury/Condition/Medication nodes
 * from health-conditions.json — the memory file onboarding writes into but
 * that no prompt reader consumes (see lib/memory.ts's loadAlwaysOnContext,
 * which has zero callers). Without this, a declared injury/condition/
 * medication never reaches lib/brain/context.ts's HARD_CONSTRAINT_TYPES.
 *
 * Drives the real ensureHealthConstraintNodes against a fake `@/db` (no
 * Postgres, same pattern as lib/memoryFilesStore.test.ts) and a fake
 * `@/lib/memoryFilesStore` (no filesystem/Postgres — controls what
 * health-conditions.json content the function sees). `@/db` doubles as the
 * fake for the payoff test's real assembleContext() call, so the same
 * `state.nodes` array a test writes into via ensureHealthConstraintNodes is
 * exactly what assembleContext reads back — no separate fixture duplication.
 */

type FakeNode = {
  id: string;
  user_id: string;
  type: string;
  label: string;
  properties: unknown;
  source: string;
  weight: number;
  created_at: Date;
  status: string;
  resolved_at: Date | null;
  superseded_by: string | null;
  subject_node_id: string | null;
};

const state: {
  healthJson: string | null;
  nodes: FakeNode[];
  // assembleContext-only fixtures (payoff test)
  userRow: Array<{ timezone: string | null; unit_system?: string | null }>;
  events: Array<{ type: string; timestamp: Date; payload: unknown }>;
} = {
  healthJson: null,
  nodes: [],
  userRow: [{ timezone: null }],
  events: [],
};

let nextNodeId = 1;

function extractFirstParam(condition: unknown): string {
  const { params } = new PgDialect().sqlToQuery(condition as never);
  return String(params[0]);
}

/** Mirrors the status='active' AND superseded_by IS NULL filter both
 *  ensureHealthConstraintNodes's and context.ts's real queries apply — the
 *  mock hardcodes it rather than parsing the full condition tree, since both
 *  call sites always include it. */
function activeNodesForUser(userId: string): FakeNode[] {
  return state.nodes.filter(
    (n) => n.user_id === userId && n.status === 'active' && n.superseded_by == null,
  );
}

const fakeDb = {
  select: (_cols?: unknown) => ({
    from: (table: unknown) => {
      if (table === realSchema.nodes) {
        return {
          where: (condition: unknown) => {
            const userId = extractFirstParam(condition);
            const filtered = activeNodesForUser(userId);
            // Thenable AND chainable with .orderBy() — healthConstraints.ts
            // awaits .where() directly, context.ts chains .orderBy() after it.
            const p = Promise.resolve(filtered);
            return Object.assign(p, { orderBy: async () => filtered });
          },
        };
      }
      if (table === realSchema.events) {
        return { where: () => ({ orderBy: async () => state.events }) };
      }
      if (table === realSchema.messages) {
        return { where: () => ({ orderBy: () => ({ limit: async () => [] }) }) };
      }
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => state.userRow }) };
      }
      if (table === realSchema.daily_metrics) {
        return { where: async () => [] };
      }
      if (table === realSchema.daily_briefs) {
        return { where: () => ({ limit: async () => [] }) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
  insert: (table: unknown) => ({
    values: async (row: Record<string, unknown>) => {
      if (table !== realSchema.nodes) throw new Error(`unexpected insert() table: ${String(table)}`);
      const node: FakeNode = {
        id: `node-${nextNodeId++}`,
        created_at: new Date(),
        status: 'active',
        resolved_at: null,
        superseded_by: null,
        subject_node_id: null,
        ...row,
      } as FakeNode;
      state.nodes.push(node);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/memoryFilesStore', {
  namedExports: {
    readStoredMemoryFile: async (_userId: string, filename: string): Promise<string | null> => {
      return filename === 'health-conditions.json' ? state.healthJson : null;
    },
  },
});

// Payoff test needs assembleContext's other helper-module dependencies
// mocked wholesale — same set context.assembleContext.test.ts uses.
mock.module('@/lib/brain/conversationWindow', {
  namedExports: { getConversationStart: async () => null },
});
mock.module('@/lib/brain/baselines', {
  namedExports: { getCalibration: async () => ({ status: 'ready', metrics: {} }) },
});
mock.module('@/lib/brain/tools', {
  namedExports: {
    queryAllBaselines: async () => [],
    queryScheduleWindow: async () => [],
    metricLabel: (metric: string) => metric,
    formatScheduleLine: () => '',
  },
});
mock.module('@/lib/brain/dietBudget', {
  namedExports: {
    resolveDietBudget: async () => undefined,
    lowEnergyThresholdKcal: (sex: string | null) => (sex === 'male' ? 1500 : 1200),
  },
});
// Weight-trend loading (lib/weightRepository.ts) and profile loading
// (lib/coreProfileStore.ts) feed assembleContext's weight-signals block —
// mocked wholesale, same as the other helper modules above (this test is
// about hard-constraint nodes, not weight-signal content — see
// weightSignals.test.ts).
mock.module('@/lib/weightRepository', {
  namedExports: {
    getWeightReadingsWithLazyImport: async () => [],
  },
});
mock.module('@/lib/coreProfileStore', {
  namedExports: { readCoreProfile: async () => null },
});

const healthConstraintsPromise = import('./healthConstraints');
const contextPromise = import('./context');

function reset() {
  state.healthJson = null;
  state.nodes = [];
  state.userRow = [{ timezone: null }];
  state.events = [];
  nextNodeId = 1;
}

test('declared injuries/conditions/medications become nodes of the right type, source, and weight', async () => {
  reset();
  const { ensureHealthConstraintNodes } = await healthConstraintsPromise;
  state.healthJson = JSON.stringify({
    injuries: ['Torn ACL'],
    conditions: ['Asthma'],
    medications: ['Albuterol inhaler'],
  });

  const result = await ensureHealthConstraintNodes('user-1');

  assert.equal(result.created, 3);
  assert.equal(state.nodes.length, 3);

  const byType = Object.fromEntries(state.nodes.map((n) => [n.type, n]));
  assert.equal(byType.Injury.label, 'Torn ACL');
  assert.equal(byType.Condition.label, 'Asthma');
  assert.equal(byType.Medication.label, 'Albuterol inhaler');

  for (const n of state.nodes) {
    assert.equal(n.source, 'confirmed');
    assert.equal(n.weight, 0.9);
    assert.equal(n.user_id, 'user-1');
    assert.deepEqual(n.properties, { evidence: n.label });
  }
});

test('idempotent: running twice creates nodes once; a case/whitespace-differing label is treated as already present', async () => {
  reset();
  const { ensureHealthConstraintNodes } = await healthConstraintsPromise;
  state.healthJson = JSON.stringify({ injuries: ['Torn ACL'] });

  const first = await ensureHealthConstraintNodes('user-1');
  assert.equal(first.created, 1);

  // Re-run with the exact same content — must no-op.
  const second = await ensureHealthConstraintNodes('user-1');
  assert.equal(second.created, 0);
  assert.equal(state.nodes.length, 1);

  // Re-run with a case- and whitespace-differing label for the same fact —
  // must also be treated as already present.
  state.healthJson = JSON.stringify({ injuries: ['  torn acl  '] });
  const third = await ensureHealthConstraintNodes('user-1');
  assert.equal(third.created, 0);
  assert.equal(state.nodes.length, 1);
});

test('an existing node of a different type with the same label does not block creation', async () => {
  reset();
  const { ensureHealthConstraintNodes } = await healthConstraintsPromise;
  state.nodes.push({
    id: 'existing-1', user_id: 'user-1', type: 'Condition', label: 'Asthma',
    properties: null, source: 'coach', weight: 0.6, created_at: new Date(),
    status: 'active', resolved_at: null, superseded_by: null, subject_node_id: null,
  });
  state.healthJson = JSON.stringify({ medications: ['Asthma'] }); // same label, different declared type

  const result = await ensureHealthConstraintNodes('user-1');

  assert.equal(result.created, 1);
  assert.equal(state.nodes.length, 2);
  const created = state.nodes.find((n) => n.id !== 'existing-1');
  assert.equal(created?.type, 'Medication');
  assert.equal(created?.label, 'Asthma');
});

test('a resolved or superseded existing node does NOT suppress re-creation', async () => {
  reset();
  const { ensureHealthConstraintNodes } = await healthConstraintsPromise;
  state.nodes.push(
    {
      id: 'resolved-1', user_id: 'user-1', type: 'Injury', label: 'Torn ACL',
      properties: null, source: 'confirmed', weight: 0.9, created_at: new Date(),
      status: 'resolved', resolved_at: new Date(), superseded_by: null, subject_node_id: null,
    },
    {
      id: 'superseded-1', user_id: 'user-1', type: 'Condition', label: 'Asthma',
      properties: null, source: 'confirmed', weight: 0.9, created_at: new Date(),
      status: 'superseded', resolved_at: null, superseded_by: 'some-other-node', subject_node_id: null,
    },
  );
  state.healthJson = JSON.stringify({ injuries: ['Torn ACL'], conditions: ['Asthma'] });

  const result = await ensureHealthConstraintNodes('user-1');

  assert.equal(result.created, 2, 'a resolved/superseded row must not count as "already present"');
  const activeInjury = state.nodes.find((n) => n.type === 'Injury' && n.status === 'active');
  const activeCondition = state.nodes.find((n) => n.type === 'Condition' && n.status === 'active');
  assert.ok(activeInjury, 'a fresh active Injury node must have been created');
  assert.ok(activeCondition, 'a fresh active Condition node must have been created');
});

test('tolerance: malformed JSON, a null root, missing keys, and non-array values all no-op without throwing', async () => {
  const { ensureHealthConstraintNodes } = await healthConstraintsPromise;

  const cases = [
    '{ "injuries": [nope',       // malformed JSON
    'null',                      // non-object (null) root
    '[]',                        // non-object (array) root
    '{}',                        // missing keys entirely
    '{"injuries": "not an array"}', // non-array value
  ];

  for (const raw of cases) {
    reset();
    state.healthJson = raw;
    const result = await ensureHealthConstraintNodes('user-1');
    assert.equal(result.created, 0, `expected no-op for: ${raw}`);
    assert.equal(state.nodes.length, 0);
  }
});

test('tolerance: non-string array entries are skipped individually, valid entries alongside them still create nodes', async () => {
  reset();
  const { ensureHealthConstraintNodes } = await healthConstraintsPromise;
  state.healthJson = JSON.stringify({ injuries: [123, null, {}, 'Real injury', ''] });

  const result = await ensureHealthConstraintNodes('user-1');

  assert.equal(result.created, 1);
  assert.equal(state.nodes.length, 1);
  assert.equal(state.nodes[0].type, 'Injury');
  assert.equal(state.nodes[0].label, 'Real injury');
});

test('a missing health-conditions.json (null) no-ops without throwing', async () => {
  reset();
  const { ensureHealthConstraintNodes } = await healthConstraintsPromise;
  state.healthJson = null;

  const result = await ensureHealthConstraintNodes('user-1');

  assert.equal(result.created, 0);
  assert.equal(state.nodes.length, 0);
});

/**
 * The payoff: a node created by ensureHealthConstraintNodes is not just a
 * row in `nodes` — it must actually reach the coach. assembleContext's
 * hardConstraints/promptText are what lib/brain/persona.ts's trainerLens
 * reads to refuse prescribing e.g. heavy squats over a declared injury, so
 * this proves the end of the pipe, not just the insert.
 */
test('a node created by ensureHealthConstraintNodes lands in hardConstraints and the HARD CONSTRAINTS prompt block', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 17, 12, 0, 0) });
  try {
    reset();
    const { ensureHealthConstraintNodes } = await healthConstraintsPromise;
    const { assembleContext } = await contextPromise;

    state.userRow = [{ timezone: null }];
    state.healthJson = JSON.stringify({ injuries: ['Torn ACL — no heavy squats'] });

    const backfill = await ensureHealthConstraintNodes('user-1');
    assert.equal(backfill.created, 1);

    const ctx = await assembleContext('user-1');

    const hardMatch = ctx.hardConstraints.find((n) => n.label === 'Torn ACL — no heavy squats');
    assert.ok(hardMatch, 'the backfilled Injury node must appear in ctx.hardConstraints');
    assert.equal(hardMatch?.type, 'Injury');

    const hardBlock = ctx.promptText.slice(
      ctx.promptText.indexOf('HARD CONSTRAINTS'),
      ctx.promptText.indexOf('GOALS & PREFERENCES') === -1
        ? undefined
        : ctx.promptText.indexOf('GOALS & PREFERENCES'),
    );
    assert.match(hardBlock, /Injury: Torn ACL — no heavy squats/);
  } finally {
    mock.timers.reset();
  }
});
