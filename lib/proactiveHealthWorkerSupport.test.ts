import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rawSqlTimeBindings, rawSqlTimestamp, workerErrorEvent } from './proactiveHealthWorkerSupport';

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

test('worker diagnostics expose only allowlisted stage and safe error metadata', () => {
  const error = Object.assign(new Error('user u1 device secret-token SQL select *'), {
    code: 'ERR_INVALID_ARG_TYPE',
    cause: new Error('private cause'),
    deviceToken: 'secret-token',
  });

  const event = workerErrorEvent('claim-analysis-jobs', error);

  assert.deepEqual(event, {
    event: 'proactive_worker_error',
    stage: 'claim-analysis-jobs',
    errorName: 'Error',
    code: 'ERR_INVALID_ARG_TYPE',
  });
  const serialized = JSON.stringify(event);
  for (const forbidden of ['user u1', 'secret-token', 'select *', 'private cause', 'message', 'stack', 'cause']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('worker diagnostics normalize unknown throws and discard unsafe codes', () => {
  assert.deepEqual(workerErrorEvent('process-morning-brief', 'private health content'), {
    event: 'proactive_worker_error',
    stage: 'process-morning-brief',
    errorName: 'UnknownError',
  });
  const customNamedError = Object.assign(new Error('private'), { name: 'user-u1-secret', code: 'secret-token' });
  assert.deepEqual(workerErrorEvent('deliver-notification', customNamedError), {
    event: 'proactive_worker_error',
    stage: 'deliver-notification',
    errorName: 'Error',
  });
});

test('worker diagnostics survive hostile error metadata access', () => {
  const hostileError = new Error('private health content');
  Object.defineProperties(hostileError, {
    name: { get: () => { throw new Error('private name'); } },
    code: { get: () => { throw new Error('private code'); } },
  });
  assert.deepEqual(workerErrorEvent('process-analysis-job', hostileError), {
    event: 'proactive_worker_error',
    stage: 'process-analysis-job',
    errorName: 'Error',
  });

  const hostileProxy = new Proxy({}, {
    get: () => { throw new Error('private property'); },
    getPrototypeOf: () => { throw new Error('private prototype'); },
  });
  assert.deepEqual(workerErrorEvent('claim-morning-briefs', hostileProxy), {
    event: 'proactive_worker_error',
    stage: 'claim-morning-briefs',
    errorName: 'UnknownError',
  });
});
