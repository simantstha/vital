import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateCalendarIngestBody,
  ingestCalendarBlocks,
  type CalendarIngestStore,
  type NormalizedCalendarBlock,
} from './calendarIngest';

// ── validation ──────────────────────────────────────────────────────────────

test('rejects a non-object body', () => {
  const result = validateCalendarIngestBody('nope');
  assert.equal(result.ok, false);
});

test('rejects unparseable windowStart/windowEnd', () => {
  const result = validateCalendarIngestBody({
    windowStart: 'not-a-date',
    windowEnd: '2026-07-20T00:00:00.000Z',
    blocks: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /parseable ISO dates/);
});

test('rejects windowEnd at or before windowStart', () => {
  const same = validateCalendarIngestBody({
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-16T00:00:00.000Z',
    blocks: [],
  });
  assert.equal(same.ok, false);
  if (!same.ok) assert.match(same.error, /windowEnd must be after windowStart/);

  const before = validateCalendarIngestBody({
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-15T00:00:00.000Z',
    blocks: [],
  });
  assert.equal(before.ok, false);
});

test('rejects a window spanning more than 31 days', () => {
  const result = validateCalendarIngestBody({
    windowStart: '2026-07-01T00:00:00.000Z',
    windowEnd: '2026-08-05T00:00:00.000Z', // 35 days
    blocks: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /31-day cap/);
});

test('accepts a window of exactly 31 days', () => {
  const result = validateCalendarIngestBody({
    windowStart: '2026-07-01T00:00:00.000Z',
    windowEnd: '2026-08-01T00:00:00.000Z', // exactly 31 days
    blocks: [],
  });
  assert.equal(result.ok, true);
});

test('rejects a non-array blocks field', () => {
  const result = validateCalendarIngestBody({
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-17T00:00:00.000Z',
    blocks: 'nope',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /blocks must be an array/);
});

test('rejects more than 500 blocks', () => {
  const blocks = Array.from({ length: 501 }, (_, i) => ({
    start: `2026-07-16T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
    end:   `2026-07-16T${String(i % 24).padStart(2, '0')}:30:00.000Z`,
  }));
  const result = validateCalendarIngestBody({
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-17T00:00:00.000Z',
    blocks,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /500-block cap/);
});

test('rejects a malformed block (missing start/end, wrong types)', () => {
  for (const badBlock of [
    { end: '2026-07-16T10:00:00.000Z' },                       // missing start
    { start: '2026-07-16T09:00:00.000Z' },                     // missing end
    { start: 123, end: '2026-07-16T10:00:00.000Z' },           // wrong type
    { start: '2026-07-16T09:00:00.000Z', end: '2026-07-16T10:00:00.000Z', allDay: 'yes' },
    { start: '2026-07-16T09:00:00.000Z', end: '2026-07-16T10:00:00.000Z', title: 42 },
  ]) {
    const result = validateCalendarIngestBody({
      windowStart: '2026-07-16T00:00:00.000Z',
      windowEnd: '2026-07-17T00:00:00.000Z',
      blocks: [badBlock],
    });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(badBlock)}`);
  }
});

test('rejects a block whose end is at or before its start', () => {
  const result = validateCalendarIngestBody({
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-17T00:00:00.000Z',
    blocks: [{ start: '2026-07-16T10:00:00.000Z', end: '2026-07-16T09:00:00.000Z' }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /end must be after its start/);
});

test('trims and truncates a title to 200 chars; blank title normalizes to null', () => {
  const longTitle = '  ' + 'x'.repeat(250) + '  ';
  const result = validateCalendarIngestBody({
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-17T00:00:00.000Z',
    blocks: [
      { start: '2026-07-16T09:00:00.000Z', end: '2026-07-16T09:30:00.000Z', title: longTitle },
      { start: '2026-07-16T10:00:00.000Z', end: '2026-07-16T10:30:00.000Z', title: '   ' },
      { start: '2026-07-16T11:00:00.000Z', end: '2026-07-16T11:30:00.000Z' }, // no title
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.blocks[0].title?.length, 200);
  assert.equal(result.value.blocks[0].title, 'x'.repeat(200));
  assert.equal(result.value.blocks[1].title, null);
  assert.equal(result.value.blocks[2].title, null);
});

test('normalizes allDay default to false and passes through true', () => {
  const result = validateCalendarIngestBody({
    windowStart: '2026-07-16T00:00:00.000Z',
    windowEnd: '2026-07-17T00:00:00.000Z',
    blocks: [
      { start: '2026-07-16T00:00:00.000Z', end: '2026-07-17T00:00:00.000Z', allDay: true, title: 'Offsite' },
      { start: '2026-07-16T09:00:00.000Z', end: '2026-07-16T09:30:00.000Z' },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.blocks[0].allDay, true);
  assert.equal(result.value.blocks[1].allDay, false);
});

// ── overlap-replace semantics ────────────────────────────────────────────────
// InMemoryCalendarStore mirrors exactly the overlap predicate the real
// Drizzle store issues (start_at < windowEnd AND end_at > windowStart, see
// lib/calendarIngestStore.ts) — verified independently in
// lib/calendarIngestStore.test.ts via the actual generated SQL. Testing the
// same predicate here proves the *replace* business logic (idempotent
// re-post, no duplication across window seams) without touching Postgres.

class InMemoryCalendarStore implements CalendarIngestStore {
  rows: Array<{ userId: string; block: NormalizedCalendarBlock }> = [];
  calls: Array<{ userId: string; windowStart: Date; windowEnd: Date; blockCount: number }> = [];

  async replaceWindow(
    userId: string,
    windowStart: Date,
    windowEnd: Date,
    blocks: NormalizedCalendarBlock[],
  ): Promise<number> {
    this.calls.push({ userId, windowStart, windowEnd, blockCount: blocks.length });
    this.rows = this.rows.filter((r) => !(
      r.userId === userId
      && r.block.startAt.getTime() < windowEnd.getTime()
      && r.block.endAt.getTime() > windowStart.getTime()
    ));
    for (const block of blocks) this.rows.push({ userId, block });
    return blocks.length;
  }
}

function block(startIso: string, endIso: string, title: string): NormalizedCalendarBlock {
  return { startAt: new Date(startIso), endAt: new Date(endIso), allDay: false, title };
}

test('reposting the same window replaces its blocks (idempotent full-replace)', async () => {
  const store = new InMemoryCalendarStore();
  const windowStart = new Date('2026-07-16T00:00:00.000Z');
  const windowEnd = new Date('2026-07-17T00:00:00.000Z');

  await ingestCalendarBlocks(store, 'user-1', {
    windowStart, windowEnd,
    blocks: [block('2026-07-16T09:00:00.000Z', '2026-07-16T09:30:00.000Z', 'Standup')],
  });
  assert.deepEqual(store.rows.map((r) => r.block.title), ['Standup']);

  const result = await ingestCalendarBlocks(store, 'user-1', {
    windowStart, windowEnd,
    blocks: [
      block('2026-07-16T14:00:00.000Z', '2026-07-16T14:30:00.000Z', 'Standup'),
      block('2026-07-16T16:00:00.000Z', '2026-07-16T17:00:00.000Z', '1:1'),
    ],
  });

  assert.deepEqual(result, { replaced: 2 });
  assert.deepEqual(store.rows.map((r) => r.block.title).sort(), ['1:1', 'Standup']);
  assert.equal(store.rows.length, 2); // the old 9am Standup is gone, not duplicated
});

test('a block that started before the window but overlaps into it is removed, not duplicated', async () => {
  const store = new InMemoryCalendarStore();

  // Wide first sync: one block that spans across what will become a window boundary.
  await ingestCalendarBlocks(store, 'user-1', {
    windowStart: new Date('2026-07-15T00:00:00.000Z'),
    windowEnd: new Date('2026-07-18T00:00:00.000Z'),
    blocks: [block('2026-07-16T22:00:00.000Z', '2026-07-17T02:00:00.000Z', 'Overnight flight')],
  });
  assert.equal(store.rows.length, 1);

  // Narrower re-sync for just July 17th — the flight block starts before this
  // window (July 16 22:00) but ends inside it (July 17 02:00), so it overlaps
  // and must be cleaned up even though its start_at predates windowStart.
  const result = await ingestCalendarBlocks(store, 'user-1', {
    windowStart: new Date('2026-07-17T00:00:00.000Z'),
    windowEnd: new Date('2026-07-18T00:00:00.000Z'),
    blocks: [block('2026-07-17T09:00:00.000Z', '2026-07-17T09:30:00.000Z', 'Standup')],
  });

  assert.deepEqual(result, { replaced: 1 });
  assert.deepEqual(store.rows.map((r) => r.block.title), ['Standup']);
});

test('blocks entirely outside the posted window are left untouched', async () => {
  const store = new InMemoryCalendarStore();
  await ingestCalendarBlocks(store, 'user-1', {
    windowStart: new Date('2026-07-01T00:00:00.000Z'),
    windowEnd: new Date('2026-07-02T00:00:00.000Z'),
    blocks: [block('2026-07-01T09:00:00.000Z', '2026-07-01T09:30:00.000Z', 'Old meeting')],
  });

  await ingestCalendarBlocks(store, 'user-1', {
    windowStart: new Date('2026-07-16T00:00:00.000Z'),
    windowEnd: new Date('2026-07-17T00:00:00.000Z'),
    blocks: [block('2026-07-16T09:00:00.000Z', '2026-07-16T09:30:00.000Z', 'New meeting')],
  });

  assert.deepEqual(store.rows.map((r) => r.block.title).sort(), ['New meeting', 'Old meeting']);
});

test('replaceWindow is scoped per user — one user\'s repost never touches another\'s rows', async () => {
  const store = new InMemoryCalendarStore();
  const windowStart = new Date('2026-07-16T00:00:00.000Z');
  const windowEnd = new Date('2026-07-17T00:00:00.000Z');

  await ingestCalendarBlocks(store, 'user-1', {
    windowStart, windowEnd,
    blocks: [block('2026-07-16T09:00:00.000Z', '2026-07-16T09:30:00.000Z', 'User 1 event')],
  });
  await ingestCalendarBlocks(store, 'user-2', {
    windowStart, windowEnd,
    blocks: [block('2026-07-16T10:00:00.000Z', '2026-07-16T10:30:00.000Z', 'User 2 event')],
  });

  assert.deepEqual(
    store.rows.map((r) => ({ userId: r.userId, title: r.block.title })).sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: 'user-1', title: 'User 1 event' },
      { userId: 'user-2', title: 'User 2 event' },
    ],
  );
});
