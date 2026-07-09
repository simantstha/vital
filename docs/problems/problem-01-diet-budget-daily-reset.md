# Problem 01 — Diet budget doesn't reset to zero at the start of each local day

**Status:** Diagnosed, not fixed
**Reported:** 2026-07-09
**Area:** Backend — `GET /api/today` diet budget (consumed side)

---

## Symptom

The diet budget "consumed" figure does not reset to zero at the start of a new
day. In the morning it already shows calories/macros that were actually eaten
the previous evening. The user expects `consumedKcal` (and consumed
protein/carbs/fat) to be **0 at the start of each day**.

## Expected

At the user's local midnight, consumed = 0, and it climbs through the day as
meals are logged. `remaining` starts at the full `targetKcal`.

## Root cause

The "day" is bucketed on the **UTC calendar day**, and there is **no per-user
timezone** anywhere in the system, so the reset happens at UTC midnight instead
of the user's local midnight.

### Evidence (files + lines)

1. **`app/api/today/route.ts:85-86`** — day boundary computed in UTC:
   ```ts
   const now = new Date();
   const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
   ```

2. **`app/api/today/route.ts:117`** — "today's" events are everything at/after
   that UTC boundary:
   ```ts
   const todayEvents = events.filter(e => e.timestamp >= todayStart);
   ```

3. **`app/api/today/route.ts:137-144`** — consumed totals are summed only from
   `todayEvents` of type `meal_logged`. So the sum is correct *for whatever
   window `todayStart` defines* — the window is the problem, not the summation.

4. **`app/api/meals/log/route.ts:95-96`** — meals are stamped with server UTC
   time (`timestamp: new Date()`), consistent with the read side.

5. **`db/schema.ts`** — the `users` table has **no `timezone` / `utc_offset`
   column** (only `withTimezone: true` on timestamp columns, which is about
   storage, not the user's locale). The server therefore has no way to know the
   user's local day.

6. **`lib/brain/briefCache.ts:38-39`** — `todayKey()` has the same UTC
   assumption (`new Date().toISOString().split('T')[0]`); the cached daily brief
   rolls over on the same UTC boundary. Any fix should keep these two in sync.

### Why it manifests for this user (US Central, UTC−5)

- UTC midnight = **7:00pm** the previous evening, local.
- So the server's "today" window is **yesterday 7pm → today 7pm** (local).
- At 8am local, `consumedKcal` already includes last night's post-7pm meals →
  **not zero**.
- The actual reset to zero happens at **7pm local**, mid-evening, not at local
  midnight.

### Not the cause

- **iOS is not caching a stale value.** `ios/Vital/.../Today/TodayViewModel.swift`
  (`loadTodayFromAPI`, ~line 185) refetches `/api/today` live on each load and
  maps `db.consumedKcal` straight through (~line 266). It faithfully renders
  whatever window the server returns.
- **The target/budget resolver is fine.** `resolveDietBudget` only supplies the
  daily *target* (goal-based or custom override); it has nothing to do with the
  consumed reset.

## Proposed fix (for the fix session — do NOT implement yet)

Introduce a real notion of the user's local day. Two-part change:

1. **Store the user's timezone.** Add a `timezone` (IANA string, e.g.
   `"America/Chicago"`) column to `users` in `db/schema.ts` + migration. Capture
   it at onboarding / send it from the iOS client (`TimeZone.current.identifier`)
   on an existing sync call.

2. **Compute `todayStart` in the user's timezone** in
   `app/api/today/route.ts` (and align `todayKey()` in `lib/brain/briefCache.ts`
   so the cached brief rolls over on the same local boundary). Convert "local
   midnight" back to a UTC instant for the `>= todayStart` event filter.

**Interim / simpler option** if a full timezone column is too much for one pass:
accept a timezone-offset (or IANA tz) query param / header from the iOS client
on the `/api/today` request and compute the day boundary from that. Lower
schema cost, but the value is only correct when the client supplies it.

### Files likely touched
- `db/schema.ts` (+ new migration in `db/migrations/`)
- `app/api/today/route.ts` (day-boundary computation)
- `lib/brain/briefCache.ts` (`todayKey` alignment)
- iOS: whichever call syncs profile/onboarding, to send the timezone
- `app/api/onboarding` and/or `app/api/profile` if timezone is persisted there

## Verification plan (after fix)
- With a user in a negative UTC-offset zone, confirm `consumedKcal == 0` at
  local 00:00 and that a meal logged at local 11pm still counts toward the same
  local day (not the next one).
- Confirm the daily brief cache key rolls over at local midnight, not UTC.
