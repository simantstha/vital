import assert from 'node:assert/strict';
import test from 'node:test';
import { countPushesOnLocalDay, isLocalMonday, nudgeBlockedByDailyBudget } from './dailyPushBudget';

// 2026-10-05 is a Monday; 2026-10-06 a Tuesday.
const MON = new Date('2026-10-05T15:00:00Z');
const TUE = new Date('2026-10-06T15:00:00Z');

test('counts only pushes on the user local day', () => {
  // 03:30Z Monday is still Sunday evening in New York.
  const stamps = [new Date('2026-10-05T03:30:00Z'), new Date('2026-10-05T14:00:00Z'), null];
  assert.equal(countPushesOnLocalDay(stamps, 'America/New_York', MON), 1);
  assert.equal(countPushesOnLocalDay(stamps, 'UTC', MON), 2);
});

test('isLocalMonday follows the user timezone', () => {
  assert.equal(isLocalMonday(new Date('2026-10-05T03:00:00Z'), 'Asia/Tokyo'), true);
  assert.equal(isLocalMonday(new Date('2026-10-05T03:00:00Z'), 'America/New_York'), false);
});

test('weekly review wins: nudges stand down on a Monday when the review is enabled', () => {
  assert.equal(nudgeBlockedByDailyBudget({ now: MON, tz: 'UTC', weeklyReviewEnabled: true, nonBriefPushStamps: [] }), true);
  assert.equal(nudgeBlockedByDailyBudget({ now: MON, tz: 'UTC', weeklyReviewEnabled: false, nonBriefPushStamps: [] }), false);
});

test('at most one non-brief push per local day', () => {
  assert.equal(nudgeBlockedByDailyBudget({ now: TUE, tz: 'UTC', weeklyReviewEnabled: true, nonBriefPushStamps: [] }), false);
  assert.equal(nudgeBlockedByDailyBudget({ now: TUE, tz: 'UTC', weeklyReviewEnabled: true, nonBriefPushStamps: [new Date('2026-10-06T09:00:00Z')] }), true);
  // Yesterday's push does not count against today.
  assert.equal(nudgeBlockedByDailyBudget({ now: TUE, tz: 'UTC', weeklyReviewEnabled: true, nonBriefPushStamps: [new Date('2026-10-05T09:00:00Z')] }), false);
});
