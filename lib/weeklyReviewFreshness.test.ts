import assert from 'node:assert/strict';
import test from 'node:test';
import { endOfLocalWeek, shouldRecomputeReview } from './weeklyReviewFreshness';

test('endOfLocalWeek is Sunday 23:59 local, as a UTC instant', () => {
  // Week starting Mon 2026-09-28 ends Sun 2026-10-04.
  assert.equal(endOfLocalWeek('2026-09-28', 'UTC').toISOString(), '2026-10-04T23:59:00.000Z');
  assert.equal(endOfLocalWeek('2026-09-28', 'America/New_York').toISOString(), '2026-10-05T03:59:00.000Z'); // EDT, UTC-4
  assert.equal(endOfLocalWeek('2026-09-28', 'Asia/Tokyo').toISOString(), '2026-10-04T14:59:00.000Z');
  // DST ended 2026-11-01 in New York: week 2026-10-26..11-01 ends at UTC-5.
  assert.equal(endOfLocalWeek('2026-10-26', 'America/New_York').toISOString(), '2026-11-02T04:59:00.000Z');
});

const created = new Date('2026-10-05T04:00:00Z');
const at = (h: number) => new Date(created.getTime() + h * 3_600_000);

test('shouldRecomputeReview: only while unseen and under 24h old', () => {
  assert.equal(shouldRecomputeReview({ seenAt: null, createdAt: created }, at(1), null), true);
  assert.equal(shouldRecomputeReview({ seenAt: null, createdAt: created }, at(23), null), true);
  assert.equal(shouldRecomputeReview({ seenAt: null, createdAt: created }, at(25), null), false);
  assert.equal(shouldRecomputeReview({ seenAt: at(1), createdAt: created }, at(2), null), false);
});

test('shouldRecomputeReview: app reads are throttled, the push path forces', () => {
  const now = at(2);
  assert.equal(shouldRecomputeReview({ seenAt: null, createdAt: created }, now, now.getTime() - 60_000), false);
  assert.equal(shouldRecomputeReview({ seenAt: null, createdAt: created }, now, now.getTime() - 60_000, { force: true }), true);
  assert.equal(shouldRecomputeReview({ seenAt: null, createdAt: created }, now, now.getTime() - 6 * 60_000), true);
});
