import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalProgressCache } from './goalProgressCache';

function setup() {
  let t = 1_000_000;
  const cache = createGoalProgressCache<number>({ ttlMs: 120_000, clock: () => t });
  let loads = 0;
  const load = async () => ++loads;
  return { cache, load, advance: (ms: number) => { t += ms; }, loads: () => loads };
}

test('serves from cache within the TTL and reloads after it', async () => {
  const s = setup();
  assert.equal(await s.cache.get('u', 'UTC', '2026-10-07', s.load), 1);
  s.advance(119_000);
  assert.equal(await s.cache.get('u', 'UTC', '2026-10-07', s.load), 1);
  s.advance(2_000);
  assert.equal(await s.cache.get('u', 'UTC', '2026-10-07', s.load), 2);
});

test('keys by user, timezone and local day', async () => {
  const s = setup();
  await s.cache.get('u', 'UTC', 'd1', s.load);
  await s.cache.get('v', 'UTC', 'd1', s.load);
  await s.cache.get('u', 'Asia/Tokyo', 'd1', s.load);
  await s.cache.get('u', 'UTC', 'd2', s.load);
  assert.equal(s.loads(), 4);
});

test('invalidate drops only that user', async () => {
  const s = setup();
  await s.cache.get('u', 'UTC', 'd', s.load);
  await s.cache.get('v', 'UTC', 'd', s.load);
  s.cache.invalidate('u');
  await s.cache.get('u', 'UTC', 'd', s.load);
  await s.cache.get('v', 'UTC', 'd', s.load);
  assert.equal(s.loads(), 3);
});

test('failures are not cached and propagate', async () => {
  const s = setup();
  await assert.rejects(s.cache.get('u', 'UTC', 'd', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await s.cache.get('u', 'UTC', 'd', s.load), 1);
});

test('concurrent callers share one in-flight load', async () => {
  const s = setup();
  const [a, b] = await Promise.all([s.cache.get('u', 'UTC', 'd', s.load), s.cache.get('u', 'UTC', 'd', s.load)]);
  assert.equal(a, b);
  assert.equal(s.loads(), 1);
});
