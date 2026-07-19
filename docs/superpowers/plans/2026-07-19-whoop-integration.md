# Implementation Plan: WHOOP Integration (OAuth Connect + Data Sync)

Branch: `feat/whoop-integration` (PR 1, backend). iOS work stacks on it as
`feat/whoop-integration-ios` (PR 2).

## Goal

Let a user connect their WHOOP account so Vital ingests WHOOP recovery,
sleep, strain (cycles), and workouts server-side — feeding the same
`daily_metrics` / `events` / baselines pipeline the HealthKit sync uses, so
the coach, Today view, and proactive analyses see WHOOP data with no iOS
HealthKit dependency.

## WHOOP API facts (verified 2026-07-19 from developer.whoop.com)

- **OAuth 2.0 authorization-code flow.**
  Authorize: `https://api.prod.whoop.com/oauth/oauth2/auth`
  Token: `https://api.prod.whoop.com/oauth/oauth2/token`
  Redirect URI must exactly match one registered in the WHOOP Developer
  Dashboard. `state` param required (min 8 chars) for CSRF protection.
  No PKCE documented — the flow authenticates with the client secret, so the
  exchange MUST happen on our backend, never in the iOS app.
- **Scopes**: `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`,
  `read:profile`, `read:body_measurement`, plus `offline` to receive a
  refresh token. Request only what we use (see Task 3).
- **Tokens**: access tokens are short-lived (`expires_in` seconds; 401 when
  expired). Refresh tokens are **single-use**: refreshing invalidates the old
  access token and returns a NEW refresh token. Concurrent refreshes can
  brick the connection → refresh must be serialized per user (row lock).
- **v2 endpoints** (all paginated with `limit` 1–25, `start`/`end`
  date-times, `nextToken`):
  - `GET /developer/v2/cycle` — day strain, kilojoules, avg/max HR
  - `GET /developer/v2/recovery` — recovery_score %, resting_heart_rate,
    hrv_rmssd_milli, spo2_percentage, skin_temp_celsius (keyed by cycle_id +
    sleep_id)
  - `GET /developer/v2/activity/sleep` — start/end, nap flag, stage summary,
    respiratory_rate, sleep_performance_percentage, sleep_needed
  - `GET /developer/v2/activity/workout` — start/end, sport_name, strain,
    avg/max HR, kilojoules, distance_meter
  - `GET /developer/v2/user/profile/basic`, `GET /developer/v2/user/measurement/body`
- **Webhooks (v2)**: events `recovery.updated/.deleted`,
  `sleep.updated/.deleted`, `workout.updated/.deleted` (creates arrive as
  `updated`; NO cycle/strain webhooks — cycles need polling). Payload:
  `{ user_id (int64 WHOOP id), id (UUID), type, trace_id }`. Signature:
  `X-WHOOP-Signature = base64(HMACSHA256(X-WHOOP-Signature-Timestamp + rawBody, client_secret))`.
  Must 2XX within ~1s; WHOOP retries 5 times over ~1h; reconciliation
  polling is still required to catch missed events.
- **Rate limits**: 100 req/min, 10,000 req/day (429 + `X-RateLimit-*`
  headers). Fine at our user count; backfill must still page politely.
- **A recovery for a day does not exist until the sleep closes** — querying
  at 7am before wake returns nothing for that day. Never treat absence as 0.
- Setup: create the app at developer-dashboard.whoop.com (up to 5 apps),
  register redirect URI + webhook URL, copy client ID/secret. WHOOP has an
  app-approval process before broad release; dev usage works immediately.

## Global constraints

- **Migrations**: edit `db/schema.ts`, `npx drizzle-kit generate`, commit the
  file under `db/migrations/`. NEVER `drizzle-kit push`. Additive-only;
  assume old code runs against the new schema during the deploy window.
- **Client secret is server-only**: lives in Fly secrets, used by the token
  exchange, refresh, and webhook signature check. Never shipped to iOS,
  never logged.
- **Do not corrupt HealthKit metrics.** WHOOP HRV is RMSSD; HealthKit's is
  SDNN. They are different statistics — store WHOOP HRV as its own metric
  (`whoop_hrv_rmssd`), never write into `hrv_sdnn`. Same for recovery/strain
  which have no HealthKit counterpart.
- **Dedupe risk**: users who connect WHOOP often also have WHOOP writing to
  Apple Health, so the same workout/sleep can arrive via both `/api/ingest/daily`
  (source `healthkit`) and WHOOP sync (source `whoop`). This plan keeps the
  sources in separate metric keys (workouts under a `whoop_` prefix payload,
  sleep as `whoop_sleep_min`) so nothing double-counts; merging/preferring is
  a follow-up decision, not silent magic.
- All external calls: ~5s timeout, failures degrade gracefully (log + skip;
  never fail a user-facing route because WHOOP is down).
- Tests with `npm test -- <files>`; gate `npm run lint && npm run build`.
- Conventional commits. Push + PR only; the user merges.

## Env / secrets (Task 0 — user action required)

1. Create the app in the WHOOP Developer Dashboard with scopes
   `read:recovery read:cycles read:sleep read:workout offline`.
2. Redirect URI: `https://<fly-backend-host>/api/whoop/callback`.
3. Webhook URL: `https://<fly-backend-host>/api/whoop/webhook`, v2 events.
4. Fly secrets + `.env.example` entries:
   `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`,
   `WHOOP_REDIRECT_URI` (the callback URL above).

## Task 1: `whoop_connections` table (schema + migration)

**Files**: `db/schema.ts`, generated migration under `db/migrations/`.

```ts
export const whoop_connections = p.pgTable('whoop_connections', {
  id:             p.uuid('id').primaryKey().defaultRandom(),
  user_id:        p.uuid('user_id').notNull().references(() => users.id),
  whoop_user_id:  p.bigint('whoop_user_id', { mode: 'number' }).notNull(), // int64 from WHOOP; webhook routing key
  access_token:   p.text('access_token').notNull(),
  refresh_token:  p.text('refresh_token').notNull(),   // single-use; rotated on every refresh
  expires_at:     p.timestamp('expires_at', { withTimezone: true }).notNull(),
  scopes:         p.text('scopes').notNull(),
  status:         p.text('status').default('active').notNull(), // 'active' | 'revoked' | 'error'
  last_synced_at: p.timestamp('last_synced_at', { withTimezone: true }),
  created_at:     p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at:     p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.uniqueIndex('whoop_connections_user_idx').on(t.user_id),
  p.uniqueIndex('whoop_connections_whoop_user_idx').on(t.whoop_user_id),
]);
```

Also a short-lived OAuth state table (or sign the state as a JWT with the
existing session secret — preferred, no table needed): state carries
`user_id` + nonce + expiry so the callback knows which Vital user connected.

## Task 2: WHOOP API client (`lib/whoop/client.ts`)

Pure fetch wrapper, fully unit-testable:

- `exchangeCode(code)` / `refreshTokens(refreshToken)` → token response.
- `getProfile`, `getBodyMeasurement`, paged `getCycles`, `getRecoveries`,
  `getSleeps`, `getWorkouts` (all accept `start`/`end`, follow `nextToken`,
  cap pages defensively).
- `withValidToken(connection, fn)` helper: refresh when `expires_at` is
  near, **inside a `SELECT … FOR UPDATE` on the connection row** so the
  single-use refresh token is never used twice concurrently; a refresh
  failure with `invalid_grant` marks the connection `status='error'`
  (surfaced in iOS as "reconnect WHOOP").

**Files**: `lib/whoop/client.ts`, `lib/whoop/client.test.ts`.

## Task 3: OAuth connect + callback routes

**Files**: `app/api/whoop/connect/route.ts`, `app/api/whoop/callback/route.ts`,
`app/api/whoop/status/route.ts`, `app/api/whoop/disconnect/route.ts`, tests.

- `GET /api/whoop/connect` (session-authed): builds the authorize URL
  (client_id, redirect_uri, scopes, signed `state`) and 302s to WHOOP. iOS
  opens this in `ASWebAuthenticationSession`.
- `GET /api/whoop/callback`: verify `state`, exchange the code, fetch
  `profile/basic` for `whoop_user_id`, upsert `whoop_connections`, kick off
  the initial backfill (fire-and-forget, Task 5), then 302 to the app deep
  link `vital://whoop?status=connected` (or `?status=error`). This route is
  unauthenticated (browser redirect) — identity comes from `state` only.
- `GET /api/whoop/status`: `{ connected, status, last_synced_at }` for the
  iOS settings screen.
- `POST /api/whoop/disconnect`: delete the connection row (and stored
  events remain — historical data is the user's).

## Task 4: Data mapping (`lib/whoop/mapping.ts`)

Map WHOOP records to the existing pipeline. All writes `source: 'whoop'`.
Day-keying uses the user's `timezone` (same convention as `lib/localDay.ts`)
applied to the record's `start`/cycle start.

`daily_metrics` upserts (UNIQUE(user_id, date, metric) already handles
idempotent re-sync):

| WHOOP field | metric key |
|---|---|
| recovery `score.recovery_score` | `whoop_recovery` |
| recovery `score.hrv_rmssd_milli` | `whoop_hrv_rmssd` |
| recovery `score.resting_heart_rate` | `whoop_resting_hr` |
| recovery `score.spo2_percentage` | `whoop_spo2` |
| recovery `score.skin_temp_celsius` | `whoop_skin_temp` |
| cycle `score.strain` | `whoop_day_strain` |
| sleep duration (non-nap, end−start) | `whoop_sleep_min` (payload: stages, respiratory_rate, performance %) |

Workouts append to `events` as type `workout_completed`, source `whoop`,
payload `{ whoopId, sport_name, strain, avg_hr, max_hr, kcal, distance_m }` —
idempotent by checking for an existing event with the same `whoopId`
(payload query on the existing `events_user_type_timestamp_idx` window).

After each sync batch, call the existing `recomputeBaselines` for touched
metrics (same as `/api/ingest/daily`).

`.deleted` webhook events: delete/zero the corresponding daily_metrics row
(recovery/sleep) or mark the workout event superseded — keep simple: delete
the daily_metrics row; workouts get a tombstone check on re-sync.

**Files**: `lib/whoop/mapping.ts`, `lib/whoop/mapping.test.ts`,
`lib/whoop/sync.ts` (fetch-window → map → upsert orchestration),
`lib/whoop/sync.test.ts`.

## Task 5: Backfill + reconciliation sync

- **On connect**: backfill last 30 days (cycles, recoveries, sleeps,
  workouts; paged `limit=25`). ~8–10 requests — well inside rate limits.
- **Reconciliation**: extend the existing proactive health worker loop
  (`scripts/proactive-health-worker.ts` / `lib/proactiveHealthWorker*`) with
  an hourly-per-user WHOOP sync pass: for each `active` connection, sync a
  trailing 48h window (also picks up cycles/strain, which have NO webhooks)
  and update `last_synced_at`. Respect 429 by aborting the pass.

**Files**: `lib/whoop/sync.ts` (shared with Task 4), worker wiring +
tests.

## Task 6: Webhook endpoint

**File**: `app/api/whoop/webhook/route.ts` + test.

- Read the RAW body (`await request.text()`) before JSON.parse — the HMAC is
  over the raw bytes. Verify
  `base64(HMACSHA256(timestampHeader + rawBody, WHOOP_CLIENT_SECRET))`
  against `X-WHOOP-Signature` (timing-safe compare); reject 401 otherwise.
  Also reject stale timestamps (> 5 min skew).
- Look up the connection by `user_id` (WHOOP int64). Unknown user → 202,
  drop silently.
- Respond 200 immediately; process async (fetch the single record by UUID
  via the v2 endpoint and run the Task 4 mapping). Use `trace_id` only for
  logging — the upserts are already idempotent, so duplicate deliveries are
  harmless.
- Route must be excluded from session-auth middleware.

## Task 7: Coach context

**Files**: `lib/brain/context.ts` (+ its test).

When WHOOP daily metrics exist for today/yesterday, add a compact line to
the coach context (recovery %, HRV RMSSD, day strain, sleep performance),
clearly labeled as WHOOP so the model doesn't conflate RMSSD with the
HealthKit SDNN baseline. Baselines for `whoop_*` metrics accrue via the
normal pipeline and become available to `getCalibration()` naturally.

## Task 8 (PR 2): iOS connect UI

**Files**: `ios/Vital/Sources/Features/Profile/…` (Connected Apps section),
`ios/Vital/Sources/Core/APIClient.swift`, deep-link handling in `RootView.swift`.

- Profile → "Connected apps" → WHOOP row: Connect / Connected (last sync) /
  Reconnect-on-error / Disconnect.
- Connect flow: `ASWebAuthenticationSession` pointed at
  `GET /api/whoop/connect` (attach the session JWT), callback scheme
  `vital://whoop?...` closes the sheet and refreshes `/api/whoop/status`.
- No WHOOP secrets or token handling on-device.

## Sequencing & delegation

| Step | What | Delegate |
|---|---|---|
| 1 | Task 1 schema + migration | Sonnet |
| 2 | Tasks 2+4 client & mapping (pure logic + tests) | Sonnet |
| 3 | Tasks 3+6 routes (connect/callback/status/disconnect/webhook) | Sonnet |
| 4 | Task 5 worker wiring + Task 7 context | Sonnet |
| 5 | PR 1 review, lint/build/tests, push, `gh pr create` | orchestrator |
| 6 | Task 8 iOS (stacked PR 2) | Sonnet |

## Open decisions (defaulted, flag in PR description)

1. **Token storage**: plaintext columns in Postgres (consistent with the
   rest of the DB; Supabase at-rest encryption). App-layer encryption can be
   added later without schema change.
2. **Scopes**: skipping `read:profile`/`read:body_measurement` beyond the
   one-time `profile/basic` call for `whoop_user_id` — wait, that call
   REQUIRES `read:profile`, so include it; still skip `read:body_measurement`
   (weight already flows from HealthKit/manual log).
3. **Sleep precedence**: WHOOP sleep is stored as `whoop_sleep_min`, not
   merged into the HealthKit `sleep` metric or the sleep-analysis pipeline
   yet. Feeding WHOOP sleep into `sleep_analyses` is a follow-up.
