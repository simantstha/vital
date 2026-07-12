import assert from 'node:assert/strict';
import test from 'node:test';
import { claimMorningSlot, compareDueCandidates, failOwnedMorningSlot, notificationClaimable, ownsLease } from './proactiveHealthTransitions';

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

test('DST fallback keeps local-date slot identity stable while UTC instants differ', () => {
  const format = (instant: string) => {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  assert.equal(format('2026-11-01T06:30:00Z'), '2026-11-01');
  assert.equal(format('2026-11-01T07:30:00Z'), '2026-11-01');
});
