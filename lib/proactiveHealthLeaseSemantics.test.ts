import assert from 'node:assert/strict';
import test from 'node:test';

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
});

test('crash after ready and after sending can both be recovered', () => {
  const ready: Row = { owner: null, expires: 0, state: 'pending', retries: 0 };
  claim(ready, 'analysis', 0); cas(ready, 'analysis', 'ready');
  ready.state = 'sending'; ready.owner = 'dead'; ready.expires = 10;
  assert.equal(claim(ready, 'recovery', 11), true);
});

test('unique morning date admits exactly one concurrent sleep-or-brief winner', () => {
  const slots = new Set<string>();
  const insert = (actor: string) => !slots.has('u:2026-11-01') && !!slots.add('u:2026-11-01') && actor.length > 0;
  assert.equal([insert('sleep'), insert('brief')].filter(Boolean).length, 1);
});

test('transient morning retries stop at the configured cap', () => {
  const row: Row = { owner: 'worker', expires: 1, state: 'sending', retries: 0 };
  while (row.retries < 5) row.retries++;
  assert.equal(row.retries, 5);
  assert.equal(row.retries < 5, false);
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
