import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';

test('BRAIN_TOOLS exposes get_schedule with a timing/planning/availability description', async () => {
  const tools = await import('./tools');
  const definition = tools.BRAIN_TOOLS.find((t) => t.name === 'get_schedule');

  assert.ok(definition);
  const description = String(definition.description);
  assert.match(description, /timing/i);
  assert.match(description, /planning/i);
  assert.match(description, /availability/i);
  const schema = definition.input_schema as { properties: Record<string, unknown>; required: string[] };
  assert.ok('startDate' in schema.properties);
  assert.ok('days' in schema.properties);
  assert.deepEqual(schema.required, []);
});

test('toolCallLabel surfaces "Checking your schedule…" for get_schedule', async () => {
  const tools = await import('./tools');
  assert.equal(tools.toolCallLabel('get_schedule', {}), 'Checking your schedule…');
});

test('renderScheduleBlock formats a timed block in the given IANA timezone', async () => {
  const tools = await import('./tools');
  const block = {
    id: 'b1',
    startAt: new Date('2026-07-16T19:00:00.000Z'), // 2pm CDT
    endAt: new Date('2026-07-16T19:30:00.000Z'),   // 2:30pm CDT
    allDay: false,
    title: 'Standup',
  };

  const rendered = tools.renderScheduleBlock(block, 'America/Chicago');

  assert.equal(rendered.allDay, false);
  assert.equal(rendered.title, 'Standup');
  assert.match(rendered.start, /Jul 16/);
  assert.match(rendered.start, /2:00\s?PM/);
  assert.match(rendered.end, /2:30\s?PM/);
  // end (time-only) should not repeat the date for a same-day timed block
  assert.doesNotMatch(rendered.end, /Jul/);
});

test('renderScheduleBlock falls back to "Busy" when title is null', async () => {
  const tools = await import('./tools');
  const block = {
    id: 'b2',
    startAt: new Date('2026-07-16T19:00:00.000Z'),
    endAt: new Date('2026-07-16T19:30:00.000Z'),
    allDay: false,
    title: null,
  };
  assert.equal(tools.renderScheduleBlock(block, 'UTC').title, 'Busy');
});

test('renderScheduleBlock renders an all-day block as date-only, no time component', async () => {
  const tools = await import('./tools');
  const block = {
    id: 'b3',
    startAt: new Date('2026-07-16T00:00:00.000Z'),
    endAt: new Date('2026-07-17T00:00:00.000Z'),
    allDay: true,
    title: 'Offsite',
  };
  const rendered = tools.renderScheduleBlock(block, 'America/Chicago');
  assert.equal(rendered.allDay, true);
  assert.doesNotMatch(rendered.start, /\d{1,2}:\d{2}/);
  assert.doesNotMatch(rendered.end, /\d{1,2}:\d{2}/);
});

test('renderScheduleBlock falls back to UTC instead of throwing on an invalid IANA id', async () => {
  const tools = await import('./tools');
  const block = {
    id: 'b4',
    startAt: new Date('2026-07-16T19:00:00.000Z'),
    endAt: new Date('2026-07-16T19:30:00.000Z'),
    allDay: false,
    title: 'Standup',
  };
  assert.doesNotThrow(() => tools.renderScheduleBlock(block, 'Not/A_Real_Zone'));
  const rendered = tools.renderScheduleBlock(block, 'Not/A_Real_Zone');
  assert.match(rendered.start, /7:00\s?PM/); // 19:00 UTC unchanged when treated as UTC
});

test('formatScheduleLine renders "- start–end: title" for timed blocks and "(all day)" for all-day blocks', async () => {
  const tools = await import('./tools');
  const timed = {
    id: 'b5',
    startAt: new Date('2026-07-16T19:00:00.000Z'),
    endAt: new Date('2026-07-16T19:30:00.000Z'),
    allDay: false,
    title: 'Standup',
  };
  const line = tools.formatScheduleLine(timed, 'America/Chicago');
  assert.match(line, /^- .*2:00\s?PM.*2:30\s?PM.*: Standup$/);

  const allDay = {
    id: 'b6',
    startAt: new Date('2026-07-16T00:00:00.000Z'),
    endAt: new Date('2026-07-17T00:00:00.000Z'),
    allDay: true,
    title: null,
  };
  const allDayLine = tools.formatScheduleLine(allDay, 'UTC');
  assert.match(allDayLine, /^- .*\(all day\): Busy$/);
});
