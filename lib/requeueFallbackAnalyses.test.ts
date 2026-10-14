import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackAnalysis } from './proactiveHealthWorker';
import {
  DEFAULT_REQUEUE_DAYS,
  LEGACY_FALLBACK_NARRATIVE,
  fallbackNarratives,
  formatRequeueReport,
  isFallbackNarrative,
  parseRequeueArgs,
  requeueCutoff,
  requeueFieldValues,
} from './requeueFallbackAnalyses';

test('arguments default to a 14 day dry run', () => {
  assert.deepEqual(parseRequeueArgs([]), { apply: false, days: DEFAULT_REQUEUE_DAYS });
  assert.equal(DEFAULT_REQUEUE_DAYS, 14);
});

test('--apply and --days are parsed in either form', () => {
  assert.deepEqual(parseRequeueArgs(['--apply']), { apply: true, days: 14 });
  assert.deepEqual(parseRequeueArgs(['--days', '7']), { apply: false, days: 7 });
  assert.deepEqual(parseRequeueArgs(['--apply', '--days=3']), { apply: true, days: 3 });
});

test('bad arguments are rejected rather than silently running a default', () => {
  for (const argv of [['--days'], ['--days', 'abc'], ['--days', '0'], ['--days', '-2'], ['--days', '1.5'], ['--days', '400'], ['--force'], ['apply']]) {
    assert.throws(() => parseRequeueArgs(argv), Error, argv.join(' '));
  }
});

test('the legacy wording is frozen: it is what fallbackAnalysis stored before the copy changed', () => {
  assert.equal(LEGACY_FALLBACK_NARRATIVE.workout, "We've saved this workout and it counts toward your trends. I couldn't put together a proper read on it this time.");
  assert.equal(LEGACY_FALLBACK_NARRATIVE.sleep, "We've saved last night's sleep and it counts toward your trends. I couldn't put together a proper read on it this time.");
});

test('both the legacy and the current fallback narrative match, per kind', () => {
  for (const kind of ['workout', 'sleep'] as const) {
    const current = fallbackAnalysis(kind, { type: 'Run' }).narrative;
    assert.deepEqual(fallbackNarratives(kind), [LEGACY_FALLBACK_NARRATIVE[kind], current]);
    assert.equal(isFallbackNarrative(kind, LEGACY_FALLBACK_NARRATIVE[kind]), true);
    assert.equal(isFallbackNarrative(kind, current), true);
  }
});

test('only an exact fallback narrative of the same kind matches', () => {
  const workout = fallbackAnalysis('workout', {}).narrative;
  const sleep = fallbackAnalysis('sleep', {}).narrative;
  assert.equal(isFallbackNarrative('sleep', workout), false);
  assert.equal(isFallbackNarrative('workout', sleep), false);
  assert.equal(isFallbackNarrative('workout', `${workout} `), false);
  assert.equal(isFallbackNarrative('workout', workout.toLowerCase()), false);
  assert.equal(isFallbackNarrative('workout', 'A steady run that kept your heart rate low.'), false);
  assert.equal(isFallbackNarrative('workout', ''), false);
  assert.equal(isFallbackNarrative('workout', null), false);
  assert.equal(isFallbackNarrative('workout', undefined), false);
  assert.equal(isFallbackNarrative('workout', 42), false);
});

test('the cutoff is N days before now', () => {
  assert.equal(requeueCutoff(new Date('2026-10-14T12:00:00Z'), 14).toISOString(), '2026-09-30T12:00:00.000Z');
  assert.equal(requeueCutoff(new Date('2026-10-14T12:00:00Z'), 1).toISOString(), '2026-10-13T12:00:00.000Z');
});

test('the requeue payload writes exactly the queue and suppression columns and nothing else', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  assert.deepEqual(requeueFieldValues(now), {
    status: 'pending',
    retry_count: 0,
    next_attempt_at: now,
    lease_token: null,
    lease_expires_at: null,
    notification_state: 'suppressed',
  });
  const keys = Object.keys(requeueFieldValues(now));
  // The stored result stays readable until the worker overwrites it, and the push history is untouched.
  for (const untouched of ['result', 'input_payload', 'notification_sent_at', 'notification_next_attempt_at', 'notification_retry_count', 'created_at']) {
    assert.ok(!keys.includes(untouched), `${untouched} must not be written`);
  }
});

test('the report prints counts per table and nothing identifying', () => {
  const dry = formatRequeueReport({ apply: false, days: 14 }, { workout_analyses: 8, sleep_analyses: 6 });
  assert.match(dry, /mode=dry-run/);
  assert.match(dry, /workout_analyses_matched=8/);
  assert.match(dry, /sleep_analyses_matched=6/);
  assert.match(dry, /--apply/);
  const applied = formatRequeueReport({ apply: true, days: 7 }, { workout_analyses: 2, sleep_analyses: 0 });
  assert.match(applied, /mode=apply/);
  assert.match(applied, /days=7/);
  assert.match(applied, /workout_analyses_requeued=2/);
  assert.match(applied, /sleep_analyses_requeued=0/);
  assert.doesNotMatch(applied, /--apply/);
});
