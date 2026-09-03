# Make the morning brief actually appear

**Date:** 2026-09-03
**Branch:** `feat/persist-daily-brief` (off `main`)
**Source:** `docs/audits/2026-08-31-product-audit.md` P0 #1
**⚠️ ATTENDED PR — contains a schema migration. The user merges. Do not auto-merge.**

This is the user's stated #1 daily moment. It has never worked in production.

## The actual failure loop

1. User opens Vital in the morning. The Fly machine suspended overnight
   (`fly.toml`: `auto_stop_machines = "suspend"`, `min_machines_running = 0`), so the process is
   fresh and `lib/brain/briefCache.ts`'s module-level `Map` is empty.
2. `app/api/today/route.ts:~174` misses the cache, returns `insight: ''` and `plan: []`, and
   kicks off `generateDailyBriefFromDb` in the background.
3. Generation takes 15–27s. The user has closed the app.
4. The result is written to the `Map`. The machine suspends again. **The brief is discarded.**
5. Next morning: identical.

So the brief is generated and thrown away *every day*. Vital pays for a Claude generation daily
and the user has never seen one.

**Persisting alone does not fix this.** The cache key includes the local day, so every morning
still misses on first open. The user opens once each morning — always a miss, always empty. The
fix needs persistence **and** pre-generation.

## Key finding: two different "morning brief" artifacts

- **Proactive notification brief** — worker-generated, `AnalysisKind = 'morningBrief'`, driven by
  `morningBriefEnabled` / `morningBriefTimeMinutes` (default 450 = 07:30 local) in
  `lib/proactiveHealthHttp.ts`. Already runs on schedule and already resolves the user's timezone.
- **Today-screen daily brief** — `{ insight, plan }` from `generateDailyBriefFromDb`
  (`lib/brain/brief.ts:71`). Called from **exactly one place**: the on-demand cache-miss path.

The worker already wakes at the right moment for each user. That is where the daily brief should
be warmed.

## Changes

**1. Persist the brief.** New table (name it to match existing conventions, e.g. `daily_briefs`)
keyed on the same tuple the cache key already uses: `user_id`, local-day `date` (YYYY-MM-DD), and
`unit_system` — see `briefCacheKey` in `lib/brain/briefCache.ts`. Store `insight` plus the `plan`
array, and a generated-at timestamp. Unique constraint on the tuple; upsert on write.

**2. `/api/today` reads through to Postgres.** Replace `getCachedBrief`/`setCachedBrief` with the
table. Keep the in-process `Map` only if it demonstrably helps as a read-through cache in front of
Postgres — otherwise delete it and its module. Do not leave two sources of truth. Preserve the
existing behavior that the response is **never blocked** on generation.

**3. Pre-warm from the worker.** At the user's morning slot — before they open the app — generate
and persist the brief for their local day. Reuse the existing timezone/slot resolution the
proactive worker already does rather than re-deriving it. Keep on-demand generation as a fallback
for users who open before their slot, or whose slot generation failed.

**4. `min_machines_running`.** Leave `fly.toml` **unchanged in this PR** and state the tradeoff in
the PR description instead. With the brief persisted and pre-warmed, suspension is no longer
correctness-critical — it only costs a cold-start on first request. Changing it raises cost and is
the user's call, not a side effect of a correctness fix.

## Migration rules — non-negotiable, two prior incidents

- Edit `db/schema.ts`, then run `npx drizzle-kit generate` and **commit the generated file** under
  `db/migrations/`.
- **NEVER** run `drizzle-kit push` against any non-local database, with or without `--force`. That
  is what truncated the `messages` table on 2026-07-12.
- The migration must be **additive-safe**: old code must keep working against the new schema
  during the deploy window, since the backend deploys before every client has updated.

## Verification

- `npm test` and `npx tsc --noEmit` (4 pre-existing errors in `lib/streakRepository.test.ts` and
  `lib/whoop/{mapping,sync}.test.ts` are expected — leave them).
- Tests must cover the behavior, not just the storage: a cold process with a persisted brief
  **returns it** (this is the bug — prove it); a cold process with no brief returns empty and does
  not block; the worker's pre-warm writes a brief that a subsequent cold read finds; the same user
  on a new local day gets a fresh brief rather than yesterday's.
- Confirm the generated migration file exists, is committed, and that the journal head matches
  what `scripts/ci-migrate.mjs` expects.

## Out of scope

Changing `min_machines_running` (call it out, don't do it). Any iOS change — PR #143 already made
the client render nothing rather than an empty shell when the payload is empty, so the client side
of this is done.
