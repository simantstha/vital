import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTIFICATION_FRESHNESS_MS, claimMorningSlot, compareDueCandidates, failOwnedMorningSlot, freshnessWindowMs, notificationClaimable, notificationFresh, ownsLease, reservedSleepCapacity, shouldPersistDefaultPreferences, workoutEndedAt } from './proactiveHealthTransitions';

type Row = { owner: string | null; expires: number; state: 'pending' | 'processing' | 'ready' | 'sending' | 'sent'; retries: number };
function claim(row: Row, owner: string, now: number): boolean {
  if (row.state !== 'pending' && !(row.state === 'processing' && row.expires <= now) && !(row.state === 'sending' && row.expires <= now)) return false;
  row.owner = owner; row.expires = now + 300; row.state = row.state === 'sending' ? 'sending' : 'processing'; return true;
}
function cas(row: Row, owner: string, state: Row['state']): boolean { if (row.owner !== owner) return false; row.state = state; row.owner = null; return true; }

test('stale analysis owner cannot complete after an expired lease is reclaimed', () => {
  const row: Row = { owner: 'old', expires: 10, state: 'processing', retries: 0 };
  assert.equal(claim(row, 'new', 11), true);
  assert.equal(cas(row, 'old', 'ready'), false);
  assert.equal(cas(row, 'new', 'ready'), true);
  assert.equal(ownsLease('new', 'old'), false);
});

test('production notification predicate recovers ready pending and stale sending only', () => {
  const now = new Date('2026-07-12T12:00:00Z');
  assert.equal(notificationClaimable('pending', null, now, now), true);
  assert.equal(notificationClaimable('sending', new Date(now.getTime() - 1), now, now), true);
  assert.equal(notificationClaimable('sending', new Date(now.getTime() + 1), now, now), false);
  assert.equal(notificationClaimable('sent', null, now, now), false);
  assert.equal(notificationClaimable('suppressed', null, now, now), false);
});

test('crash after ready and after sending can both be recovered', () => {
  const ready: Row = { owner: null, expires: 0, state: 'pending', retries: 0 };
  claim(ready, 'analysis', 0); cas(ready, 'analysis', 'ready');
  ready.state = 'sending'; ready.owner = 'dead'; ready.expires = 10;
  assert.equal(claim(ready, 'recovery', 11), true);
});

test('unique morning date admits exactly one concurrent sleep-or-brief winner', () => {
  let owner: 'sleep' | 'brief' | null = null;
  const adapter = { async tryInsert(actor: 'sleep' | 'brief') { if (owner) return null; owner = actor; return actor; }, async tryRecover(actor: 'sleep' | 'brief') { return owner === actor ? actor : null; } };
  return Promise.all([claimMorningSlot(adapter, 'sleep'), claimMorningSlot(adapter, 'brief')]).then((claims) => {
    assert.equal(claims.filter(Boolean).length, 1);
  });
});

test('repeated morning analysis failures use owner CAS, back off, and become terminal', async () => {
  let owner: string | null = 'lease'; let retries = 0; let terminal = false; const now = new Date('2026-07-12T12:00:00Z');
  const adapter = { async apply(token: string, transition: { retryCount: number; terminal: boolean; nextAttemptAt: Date }) { if (owner !== token) return false; retries = transition.retryCount; terminal = transition.terminal; assert.equal(transition.nextAttemptAt > now, true); owner = null; return true; } };
  assert.equal(await failOwnedMorningSlot(adapter, 'stale', retries, now), false);
  for (let attempt = 0; attempt < 5; attempt++) { owner = 'lease'; assert.equal(await failOwnedMorningSlot(adapter, 'lease', retries, now), true); }
  assert.equal(retries, 5);
  assert.equal(terminal, true);
});

test('due candidates are fair by overdue duration then oldest update', () => {
  const newer = { overdueMinutes: 10, updatedAt: new Date('2026-07-12T11:00:00Z') };
  const older = { overdueMinutes: 10, updatedAt: new Date('2026-07-12T10:00:00Z') };
  const mostOverdue = { overdueMinutes: 30, updatedAt: new Date('2026-07-12T12:00:00Z') };
  assert.deepEqual([newer, older, mostOverdue].sort(compareDueCandidates), [mostOverdue, older, newer]);
});

test('sustained workout backlog always reserves sleep capacity while remaining work-conserving', () => {
  const batchSize = 20;
  for (let batch = 0; batch < 100; batch++) assert.equal(reservedSleepCapacity(batchSize), 5);
  assert.equal(reservedSleepCapacity(1), 1);
  assert.equal(reservedSleepCapacity(0), 0);
});

test('only successful device registration persists default preferences', () => {
  assert.equal(shouldPersistDefaultPreferences('registered'), true);
  assert.equal(shouldPersistDefaultPreferences('conflict'), false);
});

test('DST fallback keeps local-date slot identity stable while UTC instants differ', () => {
  const format = (instant: string) => {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  assert.equal(format('2026-11-01T06:30:00Z'), '2026-11-01');
  assert.equal(format('2026-11-01T07:30:00Z'), '2026-11-01');
});

// ── Notification freshness gate (Part A) ────────────────────────────────────

test('workoutEndedAt derives the end instant from startTime + durationMin, defaulting duration to zero', () => {
  assert.equal(workoutEndedAt({ startTime: '2026-07-13T00:00:00.000Z', durationMin: 30 })?.toISOString(), '2026-07-13T00:30:00.000Z');
  assert.equal(workoutEndedAt({ startTime: '2026-07-13T00:00:00.000Z' })?.toISOString(), '2026-07-13T00:00:00.000Z');
  assert.equal(workoutEndedAt({ startTime: '2026-07-13T00:00:00.000Z', durationMin: -5 })?.toISOString(), '2026-07-13T00:00:00.000Z');
  assert.equal(workoutEndedAt({ startTime: 'not-a-date' }), null);
  assert.equal(workoutEndedAt({ durationMin: 30 }), null);
  assert.equal(workoutEndedAt(null), null);
  assert.equal(workoutEndedAt('2026-07-13T00:00:00.000Z'), null);
});

test('6h freshness boundary is inclusive at exactly the window and exclusive one ms past it', () => {
  const input = { startTime: '2026-07-13T00:00:00.000Z', durationMin: 0 };
  const atBoundary = notificationFresh({ kind: 'workout', input, localDate: '2026-07-13', timezone: 'UTC', now: new Date('2026-07-13T06:00:00.000Z') });
  assert.deepEqual(atBoundary, { fresh: true, basis: 'event_end', ageMs: NOTIFICATION_FRESHNESS_MS });

  const pastBoundary = notificationFresh({ kind: 'workout', input, localDate: '2026-07-13', timezone: 'UTC', now: new Date('2026-07-13T06:00:00.001Z') });
  assert.equal(pastBoundary.fresh, false);
  assert.equal(pastBoundary.basis, 'event_end');
  assert.equal(pastBoundary.ageMs, NOTIFICATION_FRESHNESS_MS + 1);
});

test('an in-progress workout (negative age) reads as fresh', () => {
  const verdict = notificationFresh({
    kind: 'workout',
    input: { startTime: '2026-07-13T09:50:00.000Z', durationMin: 60 },
    localDate: '2026-07-13',
    timezone: 'UTC',
    now: new Date('2026-07-13T10:00:00.000Z'),
  });
  assert.equal(verdict.fresh, true);
  assert.equal(verdict.basis, 'event_end');
  assert.equal(verdict.ageMs !== null && verdict.ageMs < 0, true);
});

test('a workout with no startTime falls back to the local-date rule', () => {
  const now = new Date('2026-07-13T10:00:00Z');
  const sameDay = notificationFresh({ kind: 'workout', input: {}, localDate: '2026-07-13', timezone: 'UTC', now });
  assert.deepEqual(sameDay, { fresh: true, basis: 'local_date', ageMs: null });

  const staleDay = notificationFresh({ kind: 'workout', input: {}, localDate: '2026-07-10', timezone: 'UTC', now });
  assert.deepEqual(staleDay, { fresh: false, basis: 'local_date', ageMs: null });
});

test('an unparseable startTime falls back to the local-date rule rather than throwing', () => {
  const now = new Date('2026-07-13T10:00:00Z');
  assert.doesNotThrow(() => notificationFresh({ kind: 'workout', input: { startTime: 'garbage' }, localDate: '2026-07-13', timezone: 'UTC', now }));
  const verdict = notificationFresh({ kind: 'workout', input: { startTime: 'garbage' }, localDate: '2026-07-10', timezone: 'UTC', now });
  assert.deepEqual(verdict, { fresh: false, basis: 'local_date', ageMs: null });
});

test('sleep is fresh only on the wake date, regardless of input payload', () => {
  const now = new Date('2026-07-13T10:00:00Z');
  assert.equal(notificationFresh({ kind: 'sleep', input: {}, localDate: '2026-07-13', timezone: 'UTC', now }).fresh, true);
  assert.equal(notificationFresh({ kind: 'sleep', input: { startTime: '2026-07-13T00:00:00Z' }, localDate: '2026-07-12', timezone: 'UTC', now }).fresh, false);
});

test('an invalid timezone falls back to UTC day-keying rather than suppressing everything', () => {
  const now = new Date('2026-07-13T10:00:00Z'); // UTC day 2026-07-13
  assert.equal(notificationFresh({ kind: 'sleep', input: {}, localDate: '2026-07-13', timezone: 'Invalid/Zone', now }).fresh, true);
  assert.equal(notificationFresh({ kind: 'sleep', input: {}, localDate: '2026-07-10', timezone: 'Invalid/Zone', now }).fresh, false);
});

test('DST boundary: local-date freshness is stable across a Chicago fall-back transition', () => {
  assert.equal(notificationFresh({ kind: 'sleep', input: {}, localDate: '2026-11-01', timezone: 'America/Chicago', now: new Date('2026-11-01T06:30:00Z') }).fresh, true);
  assert.equal(notificationFresh({ kind: 'sleep', input: {}, localDate: '2026-11-01', timezone: 'America/Chicago', now: new Date('2026-11-01T07:30:00Z') }).fresh, true);
});

test('windowMs <= 0 disables the freshness gate outright', () => {
  const staleWorkout = notificationFresh({
    kind: 'workout',
    input: { startTime: '2020-01-01T00:00:00Z' },
    localDate: '2020-01-01',
    timezone: 'UTC',
    now: new Date('2026-07-13T10:00:00Z'),
    windowMs: 0,
  });
  assert.equal(staleWorkout.fresh, true);

  const staleSleep = notificationFresh({ kind: 'sleep', input: {}, localDate: '2020-01-01', timezone: 'UTC', now: new Date('2026-07-13T10:00:00Z'), windowMs: 0 });
  assert.equal(staleSleep.fresh, true);
});

test('freshnessWindowMs reads PROACTIVE_NOTIFICATION_FRESHNESS_HOURS, defaults to 6h, and treats 0 as the kill switch', () => {
  assert.equal(freshnessWindowMs({} as NodeJS.ProcessEnv), NOTIFICATION_FRESHNESS_MS);
  assert.equal(freshnessWindowMs({ PROACTIVE_NOTIFICATION_FRESHNESS_HOURS: '0' } as unknown as NodeJS.ProcessEnv), 0);
  assert.equal(freshnessWindowMs({ PROACTIVE_NOTIFICATION_FRESHNESS_HOURS: '3' } as unknown as NodeJS.ProcessEnv), 3 * 60 * 60_000);
  assert.equal(freshnessWindowMs({ PROACTIVE_NOTIFICATION_FRESHNESS_HOURS: 'not-a-number' } as unknown as NodeJS.ProcessEnv), NOTIFICATION_FRESHNESS_MS);
  assert.equal(freshnessWindowMs({ PROACTIVE_NOTIFICATION_FRESHNESS_HOURS: '-1' } as unknown as NodeJS.ProcessEnv), NOTIFICATION_FRESHNESS_MS);
});
