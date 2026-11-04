import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * Pure result-shaping helpers for the coach read tools (query_events,
 * query_ontology, get_workouts). tools.ts imports `@/db` at load time, so
 * it is mocked here before ./tools is first imported — same constraint as
 * tools.queryOntology.test.ts; node:test runs each file in its own process.
 */
mock.module('@/db', { namedExports: { db: {}, schema: realSchema } });
const toolsPromise = import('./tools');

test('trimWorkoutsForModel drops hrSeries, hkUuid and sourceBundleId, keeps the rest', async () => {
  const { trimWorkoutsForModel } = await toolsPromise;
  const input = [{
    date: '2026-01-02',
    type: 'run',
    durationMin: 42,
    calories: 380,
    hkUuid: 'abc-123',
    sourceBundleId: 'com.apple.health',
    hrSeries: [120, 130, 140],
  }];
  const [trimmed] = trimWorkoutsForModel(input);
  assert.deepEqual(trimmed, { date: '2026-01-02', type: 'run', durationMin: 42, calories: 380 });
  assert.equal('hkUuid' in input[0], true, 'input must not be mutated');
});

test('trimWorkoutsForModel keeps a workout with none of the dropped keys unchanged', async () => {
  const { trimWorkoutsForModel } = await toolsPromise;
  const [trimmed] = trimWorkoutsForModel([{ date: '2026-01-02', type: 'lift' }]);
  assert.deepEqual(trimmed, { date: '2026-01-02', type: 'lift' });
});

function eventRows(count: number) {
  // Newest first, matching the query's ORDER BY timestamp DESC.
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1) - i * 60_000),
    payload: { value: i },
  }));
}

test('shapeEventRowsForModel: 100 rows are all returned and not truncated', async () => {
  const { shapeEventRowsForModel } = await toolsPromise;
  const shaped = shapeEventRowsForModel(eventRows(100));
  assert.equal(shaped.events.length, 100);
  assert.equal(shaped.truncated, false);
});

test('shapeEventRowsForModel: 101 rows return the newest 100 and set truncated', async () => {
  const { shapeEventRowsForModel } = await toolsPromise;
  const rows = eventRows(101);
  const shaped = shapeEventRowsForModel(rows);
  assert.equal(shaped.events.length, 100);
  assert.equal(shaped.truncated, true);
  assert.deepEqual(shaped.events[0], rows[0]);
  assert.deepEqual(shaped.events[99], rows[99]);
});

test('shapeEventRowsForModel: 0 rows is an empty, untruncated result', async () => {
  const { shapeEventRowsForModel } = await toolsPromise;
  assert.deepEqual(shapeEventRowsForModel([]), { events: [], truncated: false });
});

test('shapeEventRowsForModel: drops imageThumb from a meal payload and keeps the rest', async () => {
  const { shapeEventRowsForModel } = await toolsPromise;
  const timestamp = new Date('2026-01-01T12:00:00Z');
  const shaped = shapeEventRowsForModel([{
    timestamp,
    payload: { name: 'Oatmeal', kcal: 300, imageThumb: 'AAAA' },
  }]);
  assert.deepEqual(shaped.events, [{ timestamp, payload: { name: 'Oatmeal', kcal: 300 } }]);
  assert.equal(shaped.truncated, false);
});

test('shapeEventRowsForModel: a meal without a thumbnail passes through unchanged', async () => {
  const { shapeEventRowsForModel } = await toolsPromise;
  const timestamp = new Date('2026-01-01T12:00:00Z');
  const payload = { name: 'Apple', kcal: 95 };
  const shaped = shapeEventRowsForModel([{ timestamp, payload }]);
  assert.deepEqual(shaped.events, [{ timestamp, payload: { name: 'Apple', kcal: 95 } }]);
  assert.equal(shaped.events[0].payload, payload, 'no copy is made when there is nothing to strip');
});

test('shapeEventRowsForModel: a non-object payload is passed through', async () => {
  const { shapeEventRowsForModel } = await toolsPromise;
  const timestamp = new Date('2026-01-01T12:00:00Z');
  const shaped = shapeEventRowsForModel([
    { timestamp, payload: null },
    { timestamp, payload: [1, 2] },
  ]);
  assert.deepEqual(shaped.events.map((e) => e.payload), [null, [1, 2]]);
});

test('shapeEventRowsForModel: does not mutate the input payload', async () => {
  const { shapeEventRowsForModel } = await toolsPromise;
  const payload = { name: 'Pasta', imageThumb: 'BBBB' };
  shapeEventRowsForModel([{ timestamp: new Date(0), payload }]);
  assert.equal(payload.imageThumb, 'BBBB');
});

function factRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
    user_id: 'user-1',
    type: 'Habit',
    label: `Habit ${i}`,
    properties: { evidence: `evidence ${i}` },
    source: 'coach',
    weight: 0.6,
    status: 'active',
    superseded_by: null,
    created_at: new Date(Date.UTC(2026, 0, 1)),
    resolved_at: null,
    subject_node_id: null,
  }));
}

test('shapeFactRowsForModel: 100 facts are all returned and not truncated', async () => {
  const { shapeFactRowsForModel } = await toolsPromise;
  const shaped = shapeFactRowsForModel(factRows(100));
  assert.equal(shaped.facts.length, 100);
  assert.equal(shaped.truncated, false);
});

test('shapeFactRowsForModel: 101 facts return the first 100 and set truncated', async () => {
  const { shapeFactRowsForModel } = await toolsPromise;
  const shaped = shapeFactRowsForModel(factRows(101));
  assert.equal(shaped.facts.length, 100);
  assert.equal(shaped.truncated, true);
  assert.equal(shaped.facts[99].id, 'node-99');
});

test('shapeFactRowsForModel: keeps only the allowed fields', async () => {
  const { shapeFactRowsForModel } = await toolsPromise;
  const [fact] = shapeFactRowsForModel(factRows(1)).facts;
  assert.deepEqual(Object.keys(fact).sort(), [
    'created_at', 'id', 'label', 'properties', 'source', 'subject_node_id', 'type', 'weight',
  ]);
  assert.equal(fact.id, 'node-0');
  assert.equal(fact.properties && (fact.properties as Record<string, unknown>).evidence, 'evidence 0');
});

test('shapeFactRowsForModel: 0 facts is an empty, untruncated result', async () => {
  const { shapeFactRowsForModel } = await toolsPromise;
  assert.deepEqual(shapeFactRowsForModel([]), { facts: [], truncated: false });
});
