import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rawSqlTimeBindings, rawSqlTimestamp } from './proactiveHealthWorkerSupport';

test('raw SQL timestamps are ISO strings rather than Date instances', () => {
  const now = new Date('2026-07-13T12:34:56.789Z');
  const bindings = rawSqlTimeBindings(now, 5 * 60_000);

  assert.deepEqual(bindings, {
    now: '2026-07-13T12:34:56.789Z',
    lease: '2026-07-13T12:39:56.789Z',
  });
  assert.equal(typeof bindings.now, 'string');
  assert.equal(typeof bindings.lease, 'string');
  assert.equal(Object.values(bindings).some((value: unknown) => value instanceof Date), false);
});

test('raw SQL timestamp conversion rejects invalid dates before query execution', () => {
  assert.throws(
    () => rawSqlTimestamp(new Date(Number.NaN)),
    (error: unknown) => error instanceof TypeError && error.message === 'Invalid raw SQL timestamp.',
  );
});

test('proactive repository does not interpolate Date variables at raw SQL boundaries', () => {
  const source = readFileSync(new URL('./proactiveHealthWorkerRepository.ts', import.meta.url), 'utf8');
  const rawTemplates = [...source.matchAll(/sql(?:<[^`]+>)?`[\s\S]*?`/g)].map(([template]) => template);

  assert.ok(rawTemplates.length >= 10);
  for (const template of rawTemplates) {
    assert.doesNotMatch(template, /\$\{now\}/);
    assert.doesNotMatch(template, /\$\{lease\}/);
  }
});
