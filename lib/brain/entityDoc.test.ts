import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../../db/schema';

/**
 * entityDoc.ts tests — rendering entity documents and roster building, plus
 * the DB-backed loadEntityDoc / loadEntityRoster (see the block near the
 * bottom of this file).
 */

// ── Fake `@/db` for the DB-backed tests ──────────────────────────────────────
//
// fetchEntityCandidates issues two real drizzle queries against `nodes`: a
// selectDistinct subquery ("which node ids are referenced as a subject") and
// an outer select scoped to those ids. loadEntityDoc's fact query and
// loadEntityRoster's roster query are two more distinct `db.select(...)`
// shapes. All four share this one fake `db`, so the dispatcher below tells
// them apart by the SHAPE of the requested columns (a key unique to each
// call site: 'source' for the fact query, 'subject_node_id' for the roster
// query, else the candidates query) rather than by sniffing rendered SQL
// text. The WHERE conditions themselves ARE real drizzle SQL, rendered via
// PgDialect().sqlToQuery() — same technique as
// lib/brain/tools.queryOntology.test.ts — so a genuine filtering bug (e.g. a
// dropped user_id or status='active' clause), not just "was eq()/isNull()
// called", fails these tests.
interface FakeNodeRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  subject_node_id: string | null;
  properties: unknown;
  source: string;
  weight: number;
  status: string;
  superseded_by: string | null;
  created_at: Date;
}

function mkRow(overrides: Partial<FakeNodeRow> & { id: string; user_id: string; type: string; label: string }): FakeNodeRow {
  return {
    subject_node_id: null,
    properties: null,
    source: 'coach',
    weight: 0.6,
    status: 'active',
    superseded_by: null,
    created_at: new Date('2026-01-01'),
    ...overrides,
  };
}

let rows: FakeNodeRow[] = [];
function setRows(newRows: FakeNodeRow[]): void {
  rows = newRows;
}

function assertNodesTable(table: unknown): void {
  if (table !== realSchema.nodes) throw new Error(`unexpected table in select().from(): ${String(table)}`);
}

function selectDistinctImpl(_cols: Record<string, unknown>) {
  return {
    from: (table: unknown) => {
      assertNodesTable(table);
      return {
        where: (condition: unknown) => {
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const userId = String(params[0]);
          // Mirrors fetchEntityCandidates's subquery predicate: active,
          // non-superseded rows that themselves carry a subject (i.e. are a
          // fact ABOUT some entity), deduped. Returned as a plain array —
          // real drizzle's `subjectNodeIds` is a lazy subquery builder used
          // directly inside inArray() without being awaited first; a plain
          // array is what real drizzle's inArray() itself accepts, so this
          // is the simplest faithful stand-in.
          return [...new Set(
            rows
              .filter(r => r.user_id === userId && r.status === 'active' && r.superseded_by === null && r.subject_node_id !== null)
              .map(r => r.subject_node_id as string),
          )];
        },
      };
    },
  };
}

function selectImpl(cols: Record<string, unknown>) {
  return {
    from: (table: unknown) => {
      assertNodesTable(table);
      return {
        where: (condition: unknown) => {
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const userId = String(params[0]);
          const keys = Object.keys(cols);

          if (keys.includes('source')) {
            // loadEntityDoc's fact query:
            // and(eq(user_id), eq(subject_node_id), eq(status,'active'), isNull(superseded_by))
            const entityId = String(params[1]);
            const matches = rows.filter(r =>
              r.user_id === userId && r.subject_node_id === entityId && r.status === 'active' && r.superseded_by === null);
            // Real code chains .orderBy(...) on this query; ordering itself
            // is untested here (not in scope) — this fake returns matches
            // as-is rather than simulating sourcePrecedenceSql.
            return { orderBy: async (..._order: unknown[]) => matches };
          }

          if (keys.includes('subject_node_id')) {
            // loadEntityRoster: and(eq(user_id), eq(status,'active'), isNull(superseded_by))
            return rows.filter(r => r.user_id === userId && r.status === 'active' && r.superseded_by === null);
          }

          // fetchEntityCandidates's outer select:
          // and(eq(user_id), eq(status,'active'), isNull(superseded_by), inArray(id, subjectNodeIds))
          const ids = params.slice(2).map(String);
          return rows.filter(r =>
            r.user_id === userId && r.status === 'active' && r.superseded_by === null && ids.includes(r.id));
        },
      };
    },
  };
}

const mockDb = {
  select: (cols: Record<string, unknown>) => selectImpl(cols),
  selectDistinct: (cols: Record<string, unknown>) => selectDistinctImpl(cols),
};
mock.module('@/db', {
  namedExports: {
    db: mockDb,
    schema: realSchema,
  },
});

test('renderEntityDoc: groups facts by type, shows evidence, maps source labels, includes third-party disclaimer for non-self', async () => {
  const { renderEntityDoc } = await import('./entityDoc');

  const doc = {
    id: 'father-node-id',
    label: 'Father',
    kind: 'Person',
    isSelf: false,
    facts: [
      {
        type: 'Condition',
        label: 'Type 2 Diabetes',
        evidence: 'diagnosed at age 50',
        source: 'confirmed',
        createdAt: new Date('2026-08-15'),
      },
      {
        type: 'Medication',
        label: 'Metformin 1000mg',
        evidence: 'takes daily for diabetes',
        source: 'coach',
        createdAt: new Date('2026-08-20'),
      },
      {
        type: 'Condition',
        label: 'Hypertension',
        evidence: 'controls with diet and medication',
        source: 'confirmed',
        createdAt: new Date('2026-08-18'),
      },
    ],
  };

  const rendered = renderEntityDoc(doc);

  // Should include header
  assert.ok(rendered.includes('# Father'));
  assert.ok(rendered.includes('Person · 3 facts'));

  // Should include third-party disclaimer (isSelf=false)
  assert.ok(rendered.includes('These facts are recorded about Father'));
  assert.ok(rendered.includes('not about the user'));
  assert.ok(rendered.includes('Use them only where they bear on the'));

  // Should group by type
  assert.ok(rendered.includes('## Condition'));
  assert.ok(rendered.includes('## Medication'));

  // Should show evidence verbatim
  assert.ok(rendered.includes('diagnosed at age 50'));
  assert.ok(rendered.includes('takes daily for diabetes'));

  // Should map source labels: 'confirmed' -> 'confirmed', 'coach' -> 'from chat'
  assert.ok(rendered.includes('confirmed'));
  assert.ok(rendered.includes('from chat'));

  // Medication section should come after Condition group
  const conditionIdx = rendered.indexOf('## Condition');
  const medicationIdx = rendered.indexOf('## Medication');
  assert.ok(conditionIdx < medicationIdx);
});

test('renderEntityDoc: omits third-party disclaimer when isSelf is true', async () => {
  const { renderEntityDoc } = await import('./entityDoc');

  const doc = {
    id: 'user-id',
    label: 'Me',
    kind: 'Person',
    isSelf: true,
    facts: [
      {
        type: 'Condition',
        label: 'Celiac Disease',
        evidence: 'diagnosed via endoscopy',
        source: 'confirmed',
        createdAt: new Date('2026-01-10'),
      },
    ],
  };

  const rendered = renderEntityDoc(doc);

  // Should NOT include third-party disclaimer
  assert.ok(!rendered.includes('These facts are recorded about'));
  assert.ok(!rendered.includes('not about the user'));

  // Should still have the content
  assert.ok(rendered.includes('# Me'));
  assert.ok(rendered.includes('Person · 1 fact'));
  assert.ok(rendered.includes('Celiac Disease'));
});

test('renderEntityDoc: handles singular vs plural fact count', async () => {
  const { renderEntityDoc } = await import('./entityDoc');

  const docOne = {
    id: 'id1',
    label: 'One Fact',
    kind: 'Person',
    isSelf: true,
    facts: [
      {
        type: 'Goal',
        label: 'Run a marathon',
        evidence: 'wants to',
        source: 'coach',
        createdAt: new Date(),
      },
    ],
  };

  const docMany = {
    id: 'id2',
    label: 'Many Facts',
    kind: 'Person',
    isSelf: true,
    facts: Array(3)
      .fill(null)
      .map((_, i) => ({
        type: 'Goal',
        label: `Goal ${i}`,
        evidence: 'evidence',
        source: 'coach',
        createdAt: new Date(),
      })),
  };

  const renderedOne = renderEntityDoc(docOne);
  const renderedMany = renderEntityDoc(docMany);

  assert.ok(renderedOne.includes('1 fact'));
  assert.ok(!renderedOne.includes('1 facts'));
  assert.ok(renderedMany.includes('3 facts'));
});

test('buildEntityRoster: counts facts per entity, includes entities of any kind — not just KNOWN_SUBJECT_KINDS', async () => {
  const { buildEntityRoster } = await import('./entityDoc');

  const nodes = [
    // Entity nodes (these are the entities)
    {
      id: 'father-id',
      label: 'Father',
      type: 'Person',
      subject_node_id: null,
    },
    {
      id: 'dog-id',
      label: 'Max',
      type: 'Pet',
      subject_node_id: null,
    },
    {
      id: 'unknown-id',
      label: 'Colleague',
      type: 'Colleague', // unrecognised kind — normalizeSubjectKind (tools.ts)
      subject_node_id: null, // stores this raw rather than dropping the fact.
    },
    // Fact nodes (these reference entities as subjects)
    {
      id: 'fact-1',
      label: 'Father has diabetes',
      type: 'Condition',
      subject_node_id: 'father-id',
    },
    {
      id: 'fact-2',
      label: 'Father takes metformin',
      type: 'Medication',
      subject_node_id: 'father-id',
    },
    {
      id: 'fact-3',
      label: 'Max is 5 years old',
      type: 'Characteristic',
      subject_node_id: 'dog-id',
    },
    {
      id: 'fact-4',
      label: 'Colleague works in tech',
      type: 'Characteristic',
      subject_node_id: 'unknown-id',
    },
    // Self-fact (no subject)
    {
      id: 'self-fact-1',
      label: 'User has allergies',
      type: 'Allergy',
      subject_node_id: null,
    },
  ];

  const roster = buildEntityRoster(nodes);

  // An entity is any node referenced as a subject — including the
  // unrecognised "Colleague" kind. A type-based filter would silently drop
  // it from the roster while read_entity could still resolve and render it
  // (fetchEntityCandidates has no such filter) — that inconsistency is
  // exactly the regression this test guards against.
  assert.equal(roster.length, 3);

  // Find the father entry
  const fatherEntry = roster.find((e) => e.id === 'father-id');
  assert.ok(fatherEntry);
  assert.equal(fatherEntry.label, 'Father');
  assert.equal(fatherEntry.kind, 'Person');
  assert.equal(fatherEntry.factCount, 2); // two facts reference father-id

  // Find the dog entry
  const dogEntry = roster.find((e) => e.id === 'dog-id');
  assert.ok(dogEntry);
  assert.equal(dogEntry.label, 'Max');
  assert.equal(dogEntry.kind, 'Pet');
  assert.equal(dogEntry.factCount, 1); // one fact references dog-id

  // Find the unrecognised-kind entry — the Fix 2 regression case.
  const colleagueEntry = roster.find((e) => e.id === 'unknown-id');
  assert.ok(colleagueEntry, 'an entity whose kind is not in KNOWN_SUBJECT_KINDS must still appear in the roster');
  assert.equal(colleagueEntry.label, 'Colleague');
  assert.equal(colleagueEntry.kind, 'Colleague');
  assert.equal(colleagueEntry.factCount, 1);
});

// ── loadEntityDoc / loadEntityRoster (DB-backed) ─────────────────────────────

test('loadEntityDoc: cross-user isolation — another user\'s same-id and same-label entity+facts are never returned', async () => {
  const { loadEntityDoc } = await import('./entityDoc');

  setRows([
    mkRow({ id: 'father-u1', user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-u1', user_id: 'user-1', type: 'Condition', label: 'Diabetes',
      subject_node_id: 'father-u1', source: 'confirmed', properties: { evidence: 'diagnosed at 50' },
    }),
    // Same label, a different user's entity + fact — must never leak into user-1's lookups.
    mkRow({ id: 'father-u2', user_id: 'user-2', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-u2', user_id: 'user-2', type: 'Condition', label: 'Cancer',
      subject_node_id: 'father-u2', source: 'confirmed', properties: { evidence: 'diagnosed at 60' },
    }),
    // A fact belonging to user-2 that happens to point at user-1's entity id —
    // an adversarial/corrupt-data case the user_id filter on the fact query
    // must still exclude.
    mkRow({
      id: 'fact-u2-cross', user_id: 'user-2', type: 'Condition', label: 'Should never appear for user-1',
      subject_node_id: 'father-u1', source: 'confirmed', properties: { evidence: 'x' },
    }),
  ]);

  // By id: user-2's entity id is not resolvable for user-1, even though it exists.
  assert.equal(await loadEntityDoc('user-1', 'father-u2'), null);
  // And the reverse: user-1's entity id is not resolvable for user-2.
  assert.equal(await loadEntityDoc('user-2', 'father-u1'), null);

  // By label: "Father" resolves to user-1's own entity and ONLY user-1's fact —
  // never user-2's same-labelled entity or its facts, and never the
  // cross-user fact that points at father-u1's id.
  const doc = await loadEntityDoc('user-1', 'Father');
  assert.ok(doc);
  assert.equal(doc!.id, 'father-u1');
  assert.equal(doc!.facts.length, 1);
  assert.equal(doc!.facts[0].label, 'Diabetes');
  assert.ok(!doc!.facts.some(f => f.label === 'Cancer'));
  assert.ok(!doc!.facts.some(f => f.label === 'Should never appear for user-1'));
});

test('loadEntityDoc: excludes a resolved fact and a superseded fact from the document', async () => {
  const { loadEntityDoc } = await import('./entityDoc');

  setRows([
    mkRow({ id: 'father-1', user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-active', user_id: 'user-1', type: 'Condition', label: 'Hypertension',
      subject_node_id: 'father-1', source: 'confirmed', properties: { evidence: 'controlled with diet' },
    }),
    mkRow({
      id: 'fact-resolved', user_id: 'user-1', type: 'Condition', label: 'Old back injury',
      subject_node_id: 'father-1', source: 'coach', status: 'resolved', properties: { evidence: 'healed' },
    }),
    mkRow({
      id: 'fact-superseded', user_id: 'user-1', type: 'Condition', label: 'Provisional guess',
      subject_node_id: 'father-1', source: 'coach', superseded_by: 'fact-active', properties: { evidence: 'guess' },
    }),
  ]);

  const doc = await loadEntityDoc('user-1', 'Father');
  assert.ok(doc);
  assert.deepEqual(doc!.facts.map(f => f.label), ['Hypertension']);
});

test('loadEntityDoc: a resolved or superseded entity is not resolvable via the candidate lookup', async () => {
  const { loadEntityDoc } = await import('./entityDoc');

  setRows([
    mkRow({ id: 'resolved-entity', user_id: 'user-1', type: 'Person', label: 'Resolved Entity', status: 'resolved' }),
    mkRow({
      id: 'fact-for-resolved', user_id: 'user-1', type: 'Characteristic', label: 'Some fact',
      subject_node_id: 'resolved-entity', source: 'coach',
    }),
    mkRow({
      id: 'superseded-entity', user_id: 'user-1', type: 'Person', label: 'Superseded Entity',
      superseded_by: 'resolved-entity',
    }),
    mkRow({
      id: 'fact-for-superseded', user_id: 'user-1', type: 'Characteristic', label: 'Another fact',
      subject_node_id: 'superseded-entity', source: 'coach',
    }),
  ]);

  assert.equal(await loadEntityDoc('user-1', 'Resolved Entity'), null);
  assert.equal(await loadEntityDoc('user-1', 'resolved-entity'), null); // by id too
  assert.equal(await loadEntityDoc('user-1', 'Superseded Entity'), null);
});

test('loadEntityDoc: resolves by exact label, case-insensitively, and by an alias', async () => {
  const { loadEntityDoc } = await import('./entityDoc');

  setRows([
    mkRow({ id: 'father-1', user_id: 'user-1', type: 'Person', label: 'Father', properties: { aliases: ['Dad'] } }),
    mkRow({
      id: 'fact-1', user_id: 'user-1', type: 'Condition', label: 'Diabetes',
      subject_node_id: 'father-1', source: 'confirmed', properties: { evidence: 'diagnosed at 50' },
    }),
  ]);

  const byExactLabel = await loadEntityDoc('user-1', 'Father');
  assert.ok(byExactLabel);
  assert.equal(byExactLabel!.id, 'father-1');

  const byCaseInsensitiveLabel = await loadEntityDoc('user-1', 'father');
  assert.ok(byCaseInsensitiveLabel);
  assert.equal(byCaseInsensitiveLabel!.id, 'father-1');

  const byAlias = await loadEntityDoc('user-1', 'Dad');
  assert.ok(byAlias);
  assert.equal(byAlias!.id, 'father-1');

  assert.equal(await loadEntityDoc('user-1', 'Nonexistent Person'), null);
  assert.equal(await loadEntityDoc('user-1', ''), null);
  assert.equal(await loadEntityDoc('user-1', '   '), null);
});

test('loadEntityRoster: scoped by user_id and excludes resolved/superseded nodes', async () => {
  const { loadEntityRoster } = await import('./entityDoc');

  setRows([
    mkRow({ id: 'father-u1', user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-u1', user_id: 'user-1', type: 'Condition', label: 'Diabetes',
      subject_node_id: 'father-u1', source: 'confirmed',
    }),
    // A resolved entity, still referenced by an active fact — the DB-layer
    // status filter drops the entity row itself, so buildEntityRoster sees a
    // dangling subject_node_id reference and correctly skips it.
    mkRow({ id: 'resolved-entity-u1', user_id: 'user-1', type: 'Person', label: 'Resolved Entity', status: 'resolved' }),
    mkRow({
      id: 'fact-for-resolved-u1', user_id: 'user-1', type: 'Characteristic', label: 'Some fact',
      subject_node_id: 'resolved-entity-u1', source: 'coach',
    }),
    // Another user's entity + fact — must never appear in user-1's roster.
    mkRow({ id: 'father-u2', user_id: 'user-2', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-u2', user_id: 'user-2', type: 'Condition', label: 'Cancer',
      subject_node_id: 'father-u2', source: 'confirmed',
    }),
  ]);

  const roster = await loadEntityRoster('user-1');

  assert.equal(roster.length, 1);
  assert.equal(roster[0].id, 'father-u1');
  assert.equal(roster[0].label, 'Father');
  assert.equal(roster[0].factCount, 1);
});

test('loadEntityDoc: an entity whose kind is not in KNOWN_SUBJECT_KINDS is still resolvable', async () => {
  const { loadEntityDoc } = await import('./entityDoc');

  setRows([
    mkRow({ id: 'colleague-1', user_id: 'user-1', type: 'Colleague', label: 'Colleague Bob' }),
    mkRow({
      id: 'fact-1', user_id: 'user-1', type: 'Characteristic', label: 'Works remotely',
      subject_node_id: 'colleague-1', source: 'coach', properties: { evidence: 'mentioned in chat' },
    }),
  ]);

  const doc = await loadEntityDoc('user-1', 'Colleague Bob');
  assert.ok(doc, 'fetchEntityCandidates must derive entities from subject_node_id references, not a kind allowlist');
  assert.equal(doc!.kind, 'Colleague');
  assert.equal(doc!.facts.length, 1);
  assert.equal(doc!.facts[0].label, 'Works remotely');
});

test('buildEntityRoster: handles empty node set', async () => {
  const { buildEntityRoster } = await import('./entityDoc');

  const roster = buildEntityRoster([]);

  assert.deepEqual(roster, []);
});

test('buildEntityRoster: preserves order of first appearance', async () => {
  const { buildEntityRoster } = await import('./entityDoc');

  const nodes = [
    { id: 'id1', label: 'Person A', type: 'Person', subject_node_id: null },
    { id: 'id2', label: 'Person B', type: 'Person', subject_node_id: null },
    { id: 'fact1', label: 'Fact', type: 'Condition', subject_node_id: 'id1' },
    { id: 'fact2', label: 'Fact', type: 'Condition', subject_node_id: 'id2' },
  ];

  const roster = buildEntityRoster(nodes);

  assert.equal(roster[0].label, 'Person A');
  assert.equal(roster[1].label, 'Person B');
});

test('renderEntityDoc: orders facts by type (first-seen order)', async () => {
  const { renderEntityDoc } = await import('./entityDoc');

  const doc = {
    id: 'id1',
    label: 'Entity',
    kind: 'Person',
    isSelf: true,
    facts: [
      {
        type: 'Habit',
        label: 'runs daily',
        evidence: 'user said so',
        source: 'coach',
        createdAt: new Date(),
      },
      {
        type: 'Allergy',
        label: 'peanuts',
        evidence: 'anaphylaxis risk',
        source: 'confirmed',
        createdAt: new Date(),
      },
      {
        type: 'Habit',
        label: 'sleeps 8 hours',
        evidence: 'usual pattern',
        source: 'coach',
        createdAt: new Date(),
      },
    ],
  };

  const rendered = renderEntityDoc(doc);

  // Habit section should appear first (first-seen order)
  const habitIdx = rendered.indexOf('## Habit');
  const allergyIdx = rendered.indexOf('## Allergy');
  assert.ok(habitIdx < allergyIdx);

  // All Habit facts should be together
  const firstHabitEnd = rendered.indexOf('## Allergy');
  const secondHabit = rendered.lastIndexOf('sleeps 8 hours');
  assert.ok(secondHabit < firstHabitEnd);
});

test('renderEntityDoc: formats dates as YYYY-MM-DD', async () => {
  const { renderEntityDoc } = await import('./entityDoc');

  const doc = {
    id: 'id1',
    label: 'Entity',
    kind: 'Person',
    isSelf: true,
    facts: [
      {
        type: 'Goal',
        label: 'Marathon training',
        evidence: 'signed up',
        source: 'coach',
        createdAt: new Date('2026-09-17T14:30:00Z'),
      },
    ],
  };

  const rendered = renderEntityDoc(doc);

  assert.ok(rendered.includes('2026-09-17'));
  assert.ok(!rendered.includes('14:30')); // time should not be included
});
