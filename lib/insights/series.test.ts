import assert from 'node:assert/strict';
import test from 'node:test';

import { densify } from './series';

test('densify preserves gaps as null rather than zero', () => {
  const points = densify(
    [{ date: '2026-09-01', value: 10 }, { date: '2026-09-04', value: 40 }],
    '2026-09-01',
    '2026-09-05',
  );
  assert.deepEqual(points, [
    { date: '2026-09-01', value: 10 },
    { date: '2026-09-02', value: null },
    { date: '2026-09-03', value: null },
    { date: '2026-09-04', value: 40 },
    { date: '2026-09-05', value: null },
  ]);
});

test('densify keeps a genuine zero distinct from a gap', () => {
  const points = densify([{ date: '2026-09-02', value: 0 }], '2026-09-01', '2026-09-02');
  assert.equal(points[0].value, null);
  assert.equal(points[1].value, 0);
});

test('densify returns ascending dates and ignores rows outside the window', () => {
  const points = densify(
    [{ date: '2026-08-01', value: 1 }, { date: '2026-09-02', value: 2 }],
    '2026-09-01',
    '2026-09-03',
  );
  assert.deepEqual(points.map((p) => p.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(points.map((p) => p.value), [null, 2, null]);
});

test('densify spans a month boundary correctly', () => {
  const points = densify([], '2026-08-30', '2026-09-02');
  assert.deepEqual(points.map((p) => p.date), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});
