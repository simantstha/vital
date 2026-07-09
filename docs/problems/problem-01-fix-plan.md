# Problem 01 — FIX PLAN: local-day diet budget reset (travel-aware)

**Companion to:** `problem-01-diet-budget-daily-reset.md`
**Status:** Planned, not yet implemented
**Decisions locked (2026-07-09):**
- **TZ source:** store an IANA `timezone` on the user **and refresh it from the
  device on every `/api/today` call** → always reflects where the user currently
  is (travel-aware), and background jobs can read the last-known value.
- **Scope:** *Core + cache key* only — fix the diet-budget day boundary in
  `/api/today` and align the brief cache key. Coach/brief internal day buckets
  (`brief.ts`, `context.ts`) are **explicitly deferred** (see §7).

---

## 1. Root cause recap

`/api/today` buckets "today's" consumed calories/macros on the **UTC calendar
day** (`Date.UTC(...)`, `app/api/today/route.ts:86`), and there is **no user
timezone** stored anywhere (`db/schema.ts`). For a UTC−5 user, "today" runs
yesterday-7pm → today-7pm local, so the budget isn't zero at local midnight and
resets mid-evening. Full evidence in the companion diagnosis doc.

## 2. Approach (why this shape)

- **Bucket events by the user's *local calendar date*, not by a UTC instant.**
  Comparing `localDayKey(eventTimestamp, tz) === localDayKey(now, tz)` is
  **DST-proof** and needs no offset arithmetic — it just asks "did this event
  happen on the same local calendar day as now?"
- **Timezone comes from the device, every request** (`TimeZone.current`), so it
  auto-tracks travel and DST. We also **persist** it on `users.timezone` so the
  background brief / `/api/brief` (which run without the query param) can compute
  the same local day.
- **Null/invalid tz → UTC fallback** = today's exact current behavior, so
  legacy users and any bad input are safe (no regression).

## 3. New shared helper — `lib/localDay.ts` (new file)

```ts
/**
 * Local-day helpers. Bucket absolute instants (UTC-stored timestamps) into the
 * user's *local calendar day*. Falls back to UTC when tz is missing/invalid so
 * behavior is unchanged for users without a known timezone.
 */

/** True if `tz` is a valid IANA timezone identifier (e.g. "America/Chicago"). */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * YYYY-MM-DD for the local calendar day that contains `date` in `tz`.
 * DST-proof (delegates to Intl). UTC fallback when tz is invalid/missing.
 */
export function localDayKey(date: Date, tz: string | null | undefined): string {
  if (!isValidTimeZone(tz)) return date.toISOString().slice(0, 10); // UTC fallback
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Prefer a valid request-supplied tz (freshest), else the stored one, else undefined. */
export function pickTimeZone(
  paramTz: string | null | undefined,
  storedTz: string | null | undefined,
): string | undefined {
  if (isValidTimeZone(paramTz)) return paramTz;
  if (isValidTimeZone(storedTz)) return storedTz;
  return undefined; // → UTC fallback inside localDayKey
}
```

*Note:* no `date-fns-tz`/`luxon` dependency needed — `Intl.DateTimeFormat` with
`timeZone` covers everything here.

## 4. Schema change — `db/schema.ts` + migration

Add a nullable column to the `users` table:

```ts
// inside the users table definition
timezone: p.text('timezone'),   // IANA id, e.g. "America/Chicago"; null → UTC
```

- Generate the migration: `npx drizzle-kit generate` → new file in
  `db/migrations/` (`ALTER TABLE "users" ADD COLUMN "timezone" text;`).
- **Nullable, no default** — existing `INSERT`s that omit it (auth/onboarding
  user creation) keep working; `select().from(users)` just returns an extra
  field that current consumers ignore.
- **Deploy caveat:** the release migrates via `drizzle-kit push` (see memory
  `ci-migrate-silent-failure` / the 2026-07-09 incident). After merge, confirm
  the column actually landed in prod before relying on it (a push that errors
  can still exit 0). Verify with a quick `\d users` / `list_tables`.

## 5. `/api/today/route.ts` edits (the actual bug fix)

Current consumed logic (`:85-118`, `:137-144`) uses `todayStart` (UTC). Change to
local-day bucketing:

1. **Imports:** add
   `import { localDayKey, pickTimeZone, isValidTimeZone } from '@/lib/localDay';`
2. **Read the param** near the top of `GET`:
   ```ts
   const url = new URL(request.url);
   const paramTz = url.searchParams.get('tz');
   ```
3. **Keep the DB pull generous** — leave the existing `threeDaysAgo` lower bound
   (a local day starts at most ~14h from UTC midnight, well inside 3 days). Bump
   to 4 days if you want extra margin; harmless.
4. **After `userRow` resolves**, pick the effective tz and bucket by local day:
   ```ts
   const tz = pickTimeZone(paramTz, userRow?.timezone);
   const dayKey = localDayKey(now, tz);
   const todayEvents = events.filter(e => localDayKey(e.timestamp, tz) === dayKey);
   ```
   → replaces the `e.timestamp >= todayStart` filter at `:117`. Drop the unused
   `todayStart` / `yesterdayEvents` (`:116-118`, `:146-148`).
5. **Persist the fresh tz (travel-aware), fire-and-forget**, only when it changed:
   ```ts
   if (isValidTimeZone(paramTz) && paramTz !== userRow?.timezone) {
     void db.update(schema.users)
       .set({ timezone: paramTz })
       .where(eq(schema.users.id, userId))
       .catch(err => console.error('[/api/today] tz persist failed:', err));
   }
   ```
   (A GET writing "last-seen tz" is an acceptable, cheap side-effect; the current
   response already uses `paramTz` directly, so it's correct even before this
   write commits.)
6. **Cache key uses the local day** (`:157`):
   ```ts
   const cacheKey = briefCacheKey(userId, dayKey);   // was todayKey()
   ```
   Remove the now-unused `todayKey` import.

Consumed summation (`:137-144`) is unchanged — only the set of `todayEvents`
feeding it changes.

## 6. `/api/brief/route.ts` edits (cache-key alignment)

`generate(userId)` files the brief under `todayKey()` (UTC) at `:39`. Make it
use the stored tz so it matches `/api/today`'s key:

```ts
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { localDayKey } from '@/lib/localDay';
import { setCachedBrief, briefCacheKey } from '@/lib/brain/briefCache';
// ...
async function generate(userId: string) {
  const [user] = await db.select({ timezone: schema.users.timezone })
    .from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const dayKey = localDayKey(new Date(), user?.timezone);
  // ...
  setCachedBrief(briefCacheKey(userId, dayKey), { ... });   // was todayKey()
}
```

Drop the `todayKey` import here too.

## 7. `lib/brain/briefCache.ts`

- Update the `todayKey()` doc/name expectations: it's now only a UTC fallback and
  will be unused after §5/§6. **Either delete `todayKey()`** (preferred, once both
  call sites are migrated) or leave it with a deprecation comment. `briefCacheKey`
  is unchanged — it already takes an arbitrary date string.

## 8. iOS — `APIClient.fetchToday()` (`APIClient.swift:128-130`)

```swift
func fetchToday() async throws -> TodayResponse {
    let tz = TimeZone.current.identifier                    // e.g. "America/Chicago"
    let encoded = tz.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tz
    return try await get("/api/today?tz=\(encoded)")
}
```

No model/decoding changes; the response shape is unchanged. `TimeZone.current`
re-reads the device zone each call, so travel is handled automatically.

## 9. Edge cases / guarantees

- **Legacy users (null tz):** `pickTimeZone` → undefined → `localDayKey` UTC
  fallback → identical to today's behavior. No regression until the app sends a tz.
- **Invalid `?tz=`:** rejected by `isValidTimeZone`; not persisted; falls back to
  stored/UTC.
- **DST:** local-day-key comparison delegates to `Intl`; no offset math to get
  wrong at the transition hour.
- **Travel:** each `/api/today` overwrites `users.timezone` with the device zone,
  so "today" tracks the user's current location; the background brief uses that
  last-known value.
- **Security:** tz is only fed to `Intl` and stored via a parameterized Drizzle
  update — no injection surface; invalid strings never persist.

## 10. Out of scope (deferred follow-ups — record, don't fix now)

These keep their UTC day boundary for this pass; they don't affect the reported
diet-budget bug:
- `lib/brain/brief.ts:47` — `todayStart` and the week/history/meal buckets that
  build the *insight content*. **Known minor inconsistency:** after this fix the
  brief's cache *key* is local-day but its *content* is still computed on
  UTC-day. Acceptable for now; flagged for a later "full local-day sweep."
- `lib/brain/context.ts:271` — coach "today".
- Misc `toISOString().split('T')[0]` day usages: `lib/coachState.ts:38`,
  `lib/memory.ts:90`, `lib/baselines.ts:111`, `lib/claude.ts:77,226`,
  `app/api/logs` & `app/api/trends` "since N days" windows (these are rolling
  windows, far less sensitive than a hard day boundary).

## 11. Verification plan

- **Unit:** add a tiny test for `localDayKey` — a `2026-07-09T01:00:00Z` instant
  returns `2026-07-08` for `America/Chicago` and `2026-07-09` for `UTC`.
- **API (manual):** with a seeded user, `GET /api/today?tz=America/Chicago` after
  logging a meal at ~local 8pm the previous evening → `consumedKcal` for the new
  local morning excludes that meal (was included pre-fix); logging during the
  current local day includes it.
- **Device:** run the app; at a wall-clock time where UTC and local straddle
  midnight, confirm the Today card's consumed matches only meals eaten during the
  local calendar day, and that it reads **0 at local midnight**.
- **Regression:** a user/request with no tz behaves exactly as before (UTC).
- **Cache:** confirm the brief cache key rolls at local midnight (new key after
  local midnight, not at 7pm).

## 12. Implementation checklist

- [ ] `lib/localDay.ts` — add `isValidTimeZone`, `localDayKey`, `pickTimeZone`
- [ ] `db/schema.ts` — add nullable `timezone` to `users`; generate migration
- [ ] `app/api/today/route.ts` — local-day bucketing, tz persist, local cache key
- [ ] `app/api/brief/route.ts` — read stored tz, local-day cache key
- [ ] `lib/brain/briefCache.ts` — remove/deprecate `todayKey()`
- [ ] `ios/.../APIClient.swift` — send `?tz=` from `fetchToday()`
- [ ] Unit test for `localDayKey`; manual API + device verification
- [ ] After deploy: confirm `users.timezone` column exists in prod (migration
      actually applied — see §4 caveat)
- [ ] Update `memory/project_uniapply.md` if the diet-budget/day-boundary
      behavior is documented there
```
