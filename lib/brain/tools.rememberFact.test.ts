import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * remember_fact's subject (entity) scoping — migration 0028 adds
 * nodes.subject_node_id. A fact has exactly one subject: null means "about
 * the user themself" (the default, and every fact before this feature); a
 * name resolves-or-creates an entity node the fact points at instead.
 *
 * Mirrors tools.resolveFact.test.ts's fake-store style: rememberFact() takes
 * an injectable RememberFactStore so none of this touches Postgres. The
 * fake stores below model "entity already exists" vs "entity doesn't exist
 * yet" scenarios explicitly, rather than re-implementing the real matching
 * algorithm — that algorithm (matchesSubjectName/findSubjectMatch) is
 * exported and tested directly, in isolation, below.
 */

test('a fact with no subject is recorded with subjectNodeId null (self-fact, unchanged default)', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { rememberFact } = await import('./tools');

  const insertCalls: Array<Record<string, unknown>> = [];
  const store = {
    async findSubjectCandidates() { throw new Error('must not look up a subject when none is given'); },
    async createSubjectAndFact() { throw new Error('must not create a subject when none is given'); },
    async insertFact(request: Record<string, unknown>) {
      insertCalls.push(request);
      return { nodeId: 'fact-1' };
    },
  };

  const result = await rememberFact(store, { nodeType: 'Allergy', label: 'Peanut allergy', evidence: 'I am allergic to peanuts' }, 'user-1');

  assert.deepEqual(result, { ok: true, nodeId: 'fact-1', label: 'Peanut allergy', nodeType: 'Allergy', subjectNodeId: null });
  assert.deepEqual(insertCalls, [{ userId: 'user-1', nodeType: 'Allergy', label: 'Peanut allergy', evidence: 'I am allergic to peanuts', subjectNodeId: null }]);
});

test('a subject with no existing entity creates one and the fact and reuses it on a second call (no duplicate)', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { rememberFact } = await import('./tools');

  // In-memory "database": starts with no Person named Father, gains one
  // after the first createSubjectAndFact call.
  let entities: Array<{ id: string; label: string; properties?: unknown }> = [];
  let createCalls = 0;
  let insertCalls = 0;

  const store = {
    async findSubjectCandidates(_userId: string, kind: string) {
      return kind === 'Person' ? entities : [];
    },
    async createSubjectAndFact(request: { subjectName: string }) {
      createCalls++;
      const entity = { id: 'father-entity', label: request.subjectName, properties: { aliases: [] } };
      entities = [entity];
      return { nodeId: `fact-${createCalls}`, subjectNodeId: entity.id };
    },
    async insertFact() {
      insertCalls++;
      return { nodeId: `fact-reuse-${insertCalls}` };
    },
  };

  const first = await rememberFact(store, { nodeType: 'Condition', label: 'Type 2 diabetes', evidence: 'my father has diabetes', subject: 'Father' }, 'user-1');
  const second = await rememberFact(store, { nodeType: 'Condition', label: 'High blood pressure', evidence: 'my father also has high blood pressure', subject: 'Father' }, 'user-1');

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) assert.equal(first.subjectNodeId, 'father-entity');
  if (second.ok) assert.equal(second.subjectNodeId, 'father-entity');
  assert.equal(createCalls, 1, 'the entity must only be created once');
  assert.equal(insertCalls, 1, 'the second call must reuse the entity via a plain fact insert, not create another');
});

test('an unknown subjectKind is stored as-is, never dropped', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { rememberFact } = await import('./tools');

  const findCalls: string[] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const store = {
    async findSubjectCandidates(_userId: string, kind: string) { findCalls.push(kind); return []; },
    async createSubjectAndFact(request: Record<string, unknown>) {
      createCalls.push(request);
      return { nodeId: 'fact-1', subjectNodeId: 'colleague-entity' };
    },
    async insertFact() { throw new Error('should not hit the reuse path on a miss'); },
  };

  const result = await rememberFact(store, {
    nodeType: 'Habit', label: 'Trains for marathons too', evidence: 'my colleague also runs marathons',
    subject: 'Priya', subjectKind: 'Colleague',
  }, 'user-1');

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.subjectNodeId, 'colleague-entity');
  assert.deepEqual(findCalls, ['Colleague'], 'the raw unrecognised kind must still be used to search/create, not silently swapped for Person');
  assert.equal(createCalls[0]?.kind, 'Colleague');
});

test('missing label is rejected without touching the store', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { rememberFact } = await import('./tools');

  let touched = false;
  const store = {
    async findSubjectCandidates() { touched = true; return []; },
    async createSubjectAndFact() { touched = true; return { nodeId: 'x', subjectNodeId: 'y' }; },
    async insertFact() { touched = true; return { nodeId: 'x' }; },
  };

  const result = await rememberFact(store, { nodeType: 'Habit', label: '', evidence: 'no label given' }, 'user-1');

  assert.equal(result.ok, false);
  assert.equal(touched, false);
});

test('remember_fact is registered as a BRAIN_TOOLS definition without linksTo, and a stray linksTo is ignored rather than erroring', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const tools = await import('./tools');

  const definition = tools.BRAIN_TOOLS.find((tool) => tool.name === 'remember_fact');
  assert.ok(definition, 'remember_fact must be registered in BRAIN_TOOLS');
  const schemaProps = (definition!.input_schema as { properties: Record<string, unknown> }).properties;
  assert.ok(!('linksTo' in schemaProps), 'linksTo must be retired from the tool schema');
  assert.ok('subject' in schemaProps && 'subjectKind' in schemaProps);

  const missingLabel = await tools.executeToolCall('remember_fact', { nodeType: 'Habit', evidence: 'no label', linksTo: 'Running' }, 'user-1');
  assert.match(missingLabel, /label is required/i);
});

// ── matchesSubjectName / findSubjectMatch (pure, the real matching algorithm) ──

test('matchesSubjectName resolves "my dad" and "Father" to the same entity via label or alias, case-insensitively', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { matchesSubjectName, findSubjectMatch } = await import('./tools');

  const father = { id: 'father-entity', label: 'Father', properties: { aliases: ['dad', 'my dad', 'Pops'] } };

  assert.equal(matchesSubjectName(father, 'father'), true, 'exact label, case-insensitive');
  assert.equal(matchesSubjectName(father, 'my dad'), true, 'alias match');
  assert.equal(matchesSubjectName(father, 'DAD'), true, 'alias match, case-insensitive');
  assert.equal(matchesSubjectName(father, 'Mother'), false);

  const candidates = [
    { id: 'mother-entity', label: 'Mother', properties: {} },
    father,
  ];
  assert.equal(findSubjectMatch(candidates, 'my dad')?.id, 'father-entity');
  assert.equal(findSubjectMatch(candidates, 'Grandma'), null);
});

test('normalizeSubjectKind maps case-insensitively to the known set and defaults to Person, but never rejects an unknown kind', async () => {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';
  const { normalizeSubjectKind } = await import('./tools');

  assert.equal(normalizeSubjectKind(null), 'Person');
  assert.equal(normalizeSubjectKind(''), 'Person');
  assert.equal(normalizeSubjectKind('pet'), 'Pet');
  assert.equal(normalizeSubjectKind('ORGANIZATION'), 'Organization');
  assert.equal(normalizeSubjectKind('Colleague'), 'Colleague', 'unrecognised kinds are stored raw, never dropped or coerced to Person');
});
