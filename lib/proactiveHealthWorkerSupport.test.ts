import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisAlert, rawSqlTimeBindings, rawSqlTimestamp, workerErrorEvent } from './proactiveHealthWorkerSupport';

test('workout analysis alert is a static line naming the logged workout type', () => {
  assert.deepEqual(analysisAlert('workout', { type: 'Walking' }), {
    title: 'Workout logged',
    body: 'Your walking workout has been logged.',
  });
  assert.deepEqual(analysisAlert('workout', { type: 'Running' }), {
    title: 'Workout logged',
    body: 'Your running workout has been logged.',
  });
});

test('workout analysis alert falls back to a generic body when the type is missing or non-string', () => {
  assert.deepEqual(analysisAlert('workout', {}), { title: 'Workout logged', body: 'Your workout has been logged.' });
  assert.deepEqual(analysisAlert('workout', { type: 7 }), { title: 'Workout logged', body: 'Your workout has been logged.' });
  assert.deepEqual(analysisAlert('workout', null), { title: 'Workout logged', body: 'Your workout has been logged.' });
  assert.deepEqual(analysisAlert('workout', undefined), { title: 'Workout logged', body: 'Your workout has been logged.' });
  assert.deepEqual(analysisAlert('workout', 'Walking'), { title: 'Workout logged', body: 'Your workout has been logged.' });
});

test('sleep analysis alert is a fixed static line regardless of input', () => {
  assert.deepEqual(analysisAlert('sleep', { anything: 'ignored' }), {
    title: 'Sleep logged',
    body: "Last night's sleep has been logged.",
  });
});

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

test('constructed worker raw queries bind timestamps as strings without Date parameters', async () => {
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
  const repository = await import('./proactiveHealthWorkerRepository');
  const now = new Date('2026-07-13T12:34:56.789Z');
  const cases = [
    { query: repository.buildAnalysisClaimQuery('sleep', now, 10, 'sleep-token'), timestamps: ['2026-07-13T12:34:56.789Z', '2026-07-13T12:39:56.789Z'] },
    { query: repository.buildAnalysisClaimQuery('workout', now, 10, 'workout-token'), timestamps: ['2026-07-13T12:34:56.789Z', '2026-07-13T12:39:56.789Z'] },
    { query: repository.buildReadyNotificationCandidatesQuery(now, 40), timestamps: ['2026-07-13T12:34:56.789Z'] },
    { query: repository.buildDueMorningBriefCandidatesQuery(now), timestamps: ['2026-07-13T12:34:56.789Z'] },
  ];

  for (const { query, timestamps } of cases) {
    const parameters = queryParameters(query);
    assert.equal(parameters.some((value) => value instanceof Date), false);
    for (const timestamp of timestamps) assert.ok(parameters.includes(timestamp));
  }
});

function queryParameters(query: unknown): unknown[] {
  if (query instanceof Date) return [query];
  if (typeof query !== 'object' || query === null || !('queryChunks' in query)) return [query];
  const chunks = (query as { queryChunks: unknown[] }).queryChunks;
  return chunks.flatMap((chunk) => queryParameters(chunk));
}

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

test('worker diagnostics never read valid-looking codes from unknown objects', () => {
  let stringCodeReads = 0;
  let numericCodeReads = 0;
  const stringCode = Object.defineProperty({}, 'code', { get: () => { stringCodeReads += 1; return 'ERR_INVALID_ARG_TYPE'; } });
  const numericCode = Object.defineProperty({}, 'code', { get: () => { numericCodeReads += 1; return 400; } });

  assert.deepEqual(workerErrorEvent('claim-analysis-jobs', stringCode), {
    event: 'proactive_worker_error',
    stage: 'claim-analysis-jobs',
    errorName: 'UnknownError',
  });
  assert.deepEqual(workerErrorEvent('list-notification-candidates', numericCode), {
    event: 'proactive_worker_error',
    stage: 'list-notification-candidates',
    errorName: 'UnknownError',
  });
  assert.equal(stringCodeReads, 0);
  assert.equal(numericCodeReads, 0);
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
