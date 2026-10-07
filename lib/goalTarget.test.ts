import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRaceDate, parseRaceDistanceKm, parseTargetDate, parseTargetWeightKg, parseWeeklySessionsTarget } from './goalTarget';

test('parseTargetWeightKg accepts 30–300 kg and rounds to 0.1', () => {
  assert.deepEqual(parseTargetWeightKg(30), { ok: true, value: 30 });
  assert.deepEqual(parseTargetWeightKg(300), { ok: true, value: 300 });
  assert.deepEqual(parseTargetWeightKg(72.46), { ok: true, value: 72.5 });
});

test('parseTargetWeightKg rejects out-of-range and non-numbers', () => {
  for (const v of [29.9, 300.1, 0, -5, NaN, Infinity, '70', null, undefined, {}]) {
    assert.equal(parseTargetWeightKg(v).ok, false, `expected ${String(v)} to be rejected`);
  }
});

test('parseTargetDate accepts a future date up to 3 years out', () => {
  assert.deepEqual(parseTargetDate('2026-10-07', '2026-10-06'), { ok: true, value: '2026-10-07' });
  assert.deepEqual(parseTargetDate('2029-10-06', '2026-10-06'), { ok: true, value: '2029-10-06' });
});

test('parseTargetDate rejects today, the past, > 3 years, malformed and impossible dates', () => {
  const today = '2026-10-06';
  for (const v of ['2026-10-06', '2026-10-05', '2029-10-07', '2026-13-01', '2026-02-30', '10/12/2026', '2026-1-5', 20261201, null, undefined]) {
    assert.equal(parseTargetDate(v, today).ok, false, `expected ${String(v)} to be rejected`);
  }
});

test('parseWeeklySessionsTarget accepts integers 1–14 only', () => {
  assert.deepEqual(parseWeeklySessionsTarget(1), { ok: true, value: 1 });
  assert.deepEqual(parseWeeklySessionsTarget(14), { ok: true, value: 14 });
  for (const v of [0, 15, 3.5, -1, '3', null, NaN]) {
    assert.equal(parseWeeklySessionsTarget(v).ok, false, `expected ${String(v)} to be rejected`);
  }
});

test('parseRaceDate accepts today through 2 years out', () => {
  assert.deepEqual(parseRaceDate('2026-10-06', '2026-10-06'), { ok: true, value: '2026-10-06' });
  assert.deepEqual(parseRaceDate('2028-10-06', '2026-10-06'), { ok: true, value: '2028-10-06' });
});

test('parseRaceDate rejects the past, > 2 years, malformed and impossible dates', () => {
  for (const v of ['2026-10-05', '2028-10-07', '2026-02-30', '12/30/2026', 20261230, null, undefined]) {
    assert.equal(parseRaceDate(v, '2026-10-06').ok, false, `expected ${String(v)} to be rejected`);
  }
});

test('parseRaceDistanceKm accepts presets and 1–250, rounds to 0.1', () => {
  for (const v of [5, 10, 21.1, 42.2, 1, 250]) assert.deepEqual(parseRaceDistanceKm(v), { ok: true, value: v });
  assert.deepEqual(parseRaceDistanceKm(21.0975), { ok: true, value: 21.1 });
  for (const v of [0.9, 250.1, NaN, '10', null, undefined]) {
    assert.equal(parseRaceDistanceKm(v).ok, false, `expected ${String(v)} to be rejected`);
  }
});
