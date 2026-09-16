# Vital

A personal AI health & marathon-training coach. A **native iOS app** (SwiftUI) syncs your
Apple Health data to a Next.js + Postgres backend, where an AI coach reasons over your
training load, recovery, sleep, and nutrition — and talks to you in a chat that can read
your real time-series data, log meals, and remember facts about you. A background worker
process runs proactive analysis, morning briefs, WHOOP sync, and push notifications.

Built for training toward the Twin Cities Marathon (Oct 4, 2026).

> **History:** Vital started as a fullscreen web kiosk dashboard fed by Whoop/Strava/MyFitnessPal
> with a Telegram bot. It has since pivoted to a native iOS app backed by Apple HealthKit.
> The old web dashboard has since been removed; the Next.js app is now API-only.

---

## Architecture

```
                    ┌────────────────────────────────────┐
                    │  iOS app (SwiftUI)                 │
                    │  HealthKit · calendar · coach chat │
                    │  meals · notification inbox        │
                    └───────┬────────────────▲───────────┘
                            │                │
               HTTPS / JWT  │                │  APNs push
        POST /api/ingest/*  │                │  (analysis ready,
           GET  /api/today  │                │   morning brief,
           POST /api/coach  │                │   insight nudges)
                            ▼                │
   ┌────────────────────────────────┐   ┌────┴───────────────────────────┐
   │  Next.js API — process "app"   │   │  Worker — process "worker"     │
   │  • JWT-gated /api/* routes     │   │  dist/proactive-health-worker  │
   │  • lib/brain coach engine      │   │  • analysis jobs → Claude      │
   │  • lib/claude daily brief      │   │  • morning briefs              │
   │  • WHOOP OAuth + webhook       │   │  • insight/nudge pass          │
   │  • volume /data mounted        │   │  • WHOOP sync pass             │
   │                                │   │  • APNs delivery — no volume   │
   └───────────────┬────────────────┘   └───────────────┬────────────────┘
                   │                                    │
                   └─────────────────┬──────────────────┘
                                     ▼
              ┌────────────────────────────────────────────┐
              │  Postgres (Supabase, session pooler :5432) │
              │  26 tables — users, events, nodes/edges,   │
              │  messages, daily_metrics, baselines,       │
              │  insight_findings, workout/sleep_analyses, │
              │  daily_briefs, whoop_connections, …        │
              │                                            │
              │  users.core_profile_md — canonical         │
              │  narrative coach memory                    │
              └────────────────────────────────────────────┘
```

- **Structured / quantitative data** (HealthKit aggregates, chat history, the ontology of
  facts about you, WHOOP recovery/strain) lives in **Postgres** (`db/schema.ts`, drizzle-orm).
- **Narrative coach memory** (profile, coach notes) is canonically **`users.core_profile_md`**
  in Postgres (`lib/coreProfileStore.ts`). The on-disk `.vital-memory/<userId>/` files are a
  legacy cache / back-compat target still read and written by the `read_memory`/`write_memory`
  coach tools (`lib/memory.ts`) — this split exists because the Fly volume `vital_data` mounts
  only to the `app` process, so the `worker` process (which also needs the profile for briefs)
  has no volume and would otherwise read a blank re-seeded template every time.
- The coach reads time-series only through **tools** (`lib/brain/tools.ts`) so raw data
  never bloats the prompt.
- Proactive work (analysis generation, morning briefs, insight detection, WHOOP sync, push
  delivery) all runs in a **separate `worker` process**, not in the request/response path of
  the `app` process — see "The proactive worker" below.

---

## What it does

**iOS app** (the primary product surface)
- Syncs Apple Health data — HRV, resting HR, sleep, steps, active energy, body mass,
  workouts — including a resume-safe 365-day historical backfill and live background sync.
- 7-step onboarding (Basics → Goal → Training → Health → Lifestyle → Coach intro → Calibrating).
- **Sign in with Apple** (live in production); DEBUG builds additionally show a "Dev sign-in"
  button for local/simulator testing.
- **Coach chat** over SSE, with live tool-call chips as the coach queries your data. Voice
  input via on-device speech-to-text, with ElevenLabs TTS for spoken replies (falls back to
  the system voice if unconfigured).
- Meal photo logging (Claude Vision estimates macros), barcode scan, and free-text search
  across three nutrition sources.
- Calendar sync so the coach can see your schedule around workouts.
- **Notification inbox** — a bell in the Today header plus a nudge detail screen for
  proactive pushes (workout/sleep analysis ready, morning brief, insight nudges).
- **Calibrating state:** the coach withholds recovery verdicts and prescriptions until it
  has ≥14 days of established baselines for HRV, resting HR, and sleep.

**Backend** (`app/api/*`, the `app` process)
- Multi-user, JWT-authenticated (Sign in with Apple; env-gated dev sign-in in non-prod).
- AI coach loop (`lib/brain/coach.ts`) using Anthropic tool-use, streamed as SSE.
- Daily brief generation (`lib/claude.ts`).
- WHOOP OAuth connect/disconnect + webhook ingestion (`lib/whoop/`).
- Specialist sub-agents (flag-gated) for domain-specific coaching (running, nutrition,
  strength, …), each with a restricted tool allowlist.
- Nutrition lookup across USDA FoodData Central, Open Food Facts (barcode), and
  CalorieNinjas (free-text fallback), plus Claude Vision for photos.

**The proactive worker** (`scripts/proactive-health-worker.ts`, the `worker` process)
- A second Fly.io process in the same app, built separately via `npm run build:worker`
  (esbuild → `dist/proactive-health-worker.cjs`), restart policy `always`, **no volume mount**.
- Polls every `PROACTIVE_WORKER_INTERVAL_MS` (default 15000ms) and, per pass:
  1. Claims pending workout/sleep analysis jobs and generates the analysis with Claude.
  2. Claims morning briefs that are due and generates them.
  3. Runs the insight/nudge detection pass over recent metrics.
  4. Runs the WHOOP sync/reconciliation pass.
  5. Delivers queued APNs pushes for all of the above.
- Requires `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, and `APNS_PRIVATE_KEY` — it throws on
  startup if any is missing. `APNS_PRIVATE_KEY` holds the `.p8` file contents with literal
  `\n` escapes, which the worker expands to real newlines.
- Supporting modules: the `lib/proactiveAnalysis*.ts` and `lib/proactiveHealth*.ts` files
  (job claiming/transitions, grounding, formatting, recovery-from-failure), plus
  `lib/apnsClient.ts`, `lib/dailyBriefPrewarm.ts`, `lib/pushDeviceReconciliation.ts`.

**Insight / nudge engine** (`lib/insights/`)
- Detectors: `cadence_break | level_shift | trend | cross_lag | day_of_week`, gated by
  statistical significance (see `lib/insights/stats.ts`, an arbiter, and evidence assembly)
  before becoming a persisted finding.
- Findings and confirmable nudges live in `insight_findings` / `pending_nudges`.
- Design rule enforced in `lib/insights/types.ts`: a day with no observation stays `null` in
  the series — absence is never coerced to zero.

---

## Repository layout

```
app/
  api/                        # The real backend (app process). Key routes:
    auth/{apple,dev}/           # Sign in with Apple + env-gated dev sign-in → session JWT
    coach/                       # Coach chat (SSE, streaming tool-use loop)
    coach-state/ diet-goal/       # Coach scratch state, diet budget
    ingest/{daily,calendar}/       # HealthKit aggregate upsert, calendar block sync
    today/ trends/ logs/             # Read models for the iOS Today / Trends / Logs tabs
    onboarding/                       # Writes profile + memory, sets users.onboarded_at
    profile/                           # Profile + calibration state
    meals/{log,modify,recipe}/          # Interactive meal plan
    nutrition/{barcode,search,photo,recents}/  # USDA / OFF / CalorieNinjas / Claude Vision
    pending-facts/{resolve}/             # Confirmation-gated learning queue
    plan/                                 # plan_items, daily_coach_recommendations
    streak/                                # streak.ts / streakRepository.ts
    whoop/{connect,callback,disconnect,status,webhook}/  # OAuth + webhook sync
    workout-analyses/[id]/ sleep-analyses/[id]/           # Proactive analysis detail
    morning-briefs/[id]/                                   # Morning brief detail
    notifications/{read}/ notification-preferences/         # Notification inbox
    push-devices/ nudges/[id]/                               # Device tokens, nudge detail
    stt/ tts/                                                 # Voice: speech-to-text, ElevenLabs TTS
    brief/ weight-log/ health/
  globals.css                 # Glassmorphic design system

lib/
  brain/                       # Postgres-era coach engine
    coach.ts                     # runCoach() — multi-turn streaming tool-use loop
    tools.ts                     # Tool inventory (query_events, get_metric_trend, log_meal, …)
    context.ts                   # Deterministic context assembled from Postgres
    persona.ts                   # System prompt (constraints, calibration state, onboarding)
    baselines.ts                 # Baseline stats + "established" gating
    recovery.ts                  # Composite recovery score
    metricThresholds.ts          # Shared change-detection thresholds
    dietBudget.ts nutritionIntake.ts whoopContext.ts
    conversationWindow.ts coachViz.ts dailyBriefRepository.ts
    anthropicClient.ts brief.ts briefCache.ts
  insights/                    # Detector/arbiter/evidence engine — see above
  specialists/                 # Flag-gated specialist sub-agents + registry, orchestration
  whoop/                       # client, mapping, connection state, sync, worker pass
  nutrition/                   # USDA candidate search
  claude.ts                    # generateDailyBrief() — JSON daily brief
  auth.ts                      # SIWA verification (jose), session JWT issue/verify
  coreProfileStore.ts          # Canonical narrative profile (users.core_profile_md)
  memory.ts                    # Legacy file-based narrative memory (tool seam)
  dataDir.ts                   # Resolves .vital-memory / .brief-cache root (VITAL_DATA_DIR)
  units.ts                     # Imperial/metric display; storage is always metric
  localDay.ts metricCatalog.ts metricFormat.ts logItems.ts profileDetails.ts trendsResponse.ts
  notificationInbox*.ts        # Inbox read models + repository
  apnsClient.ts                # APNs delivery
  dailyBriefPrewarm.ts healthAnalysisIngest.ts healthAnalysisReconciliation.ts
  pushDeviceReconciliation.ts
  calendarIngest.ts calendarIngestStore.ts
  streak.ts streakRepository.ts
  proactiveAnalysis*.ts proactiveHealth*.ts  # Job claiming, transitions, grounding, formatting
  nutritionix.ts                # CalorieNinjas food lookup (file name is a legacy misnomer)
  openFoodFacts.ts              # Barcode lookup
  coachState.ts weightLog.ts types.ts

db/                            # drizzle-orm schema + migrations (Postgres, 26 migrations)
scripts/
  proactive-health-worker.ts     # Worker entry point (bundled → dist/, run as Fly process "worker")
  ci-migrate.mjs                 # Production migration runner (see below)
  seed-dev.ts

middleware.ts                  # Edge JWT gate for /api/* (fails closed 503 in prod w/o SESSION_JWT_SECRET)

ios/Vital/                     # Native SwiftUI app (see ios/ section below)

vital-memory-template/         # Per-user memory seed files (baked into the Docker image)

docs/                          # vital-architecture-v0.1.md, CI-TESTFLIGHT.md, fly-deploy.md, …
```

---

## Backend — local development

### 1. Install dependencies

```bash
npm install
```

### 2. Environment (`.env.local`)

`.env.example` is the canonical, commented list of every env var the codebase reads — copy
it to `.env.local` and fill in real values. Highlights:

- `DATABASE_URL` — local dev Postgres, or a Supabase Session-pooler URL (port **5432**, not 6543).
- `ANTHROPIC_API_KEY` — coach, meal reactions, proactive analysis, daily brief.
- `PROACTIVE_ANALYSIS_MODEL` — optional; code default is `claude-sonnet-5`
  (`DEFAULT_PROACTIVE_ANALYSIS_MODEL` in `lib/proactiveAnalysisGeneration.ts`). **In
  production this is set as a Fly secret and the env var overrides the code default** — changing
  the code constant alone has no production effect.
- `SPECIALISTS_ENABLED` / `SPECIALIST_MODEL` — specialist sub-agents are off unless
  `SPECIALISTS_ENABLED` is exactly the string `"true"`; `SPECIALIST_MODEL` is required once enabled.
- `CALORIENINJAS_API_KEY`, `USDA_FDC_API_KEY` — nutrition text search / candidate lookup.
- `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` — coach voice TTS; optional, falls back to the
  Apple voice on-device.
- `SESSION_JWT_SECRET`, `APPLE_BUNDLE_ID`, `DEV_AUTH_SECRET` — session JWT + Sign in with Apple
  verification + env-gated dev sign-in bypass.
- `VITAL_DATA_DIR`, `VITAL_MEMORY_TEMPLATE_DIR` — file-backed store root and memory template
  override (see `lib/memory.ts`, `lib/dataDir.ts`).
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `APNS_PRIVATE_KEY` — required by the proactive
  worker; it throws on startup if any is missing.
- `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI` — WHOOP OAuth connect + webhook.

> ⚠️ **`VITAL_DATA_DIR` must be outside the repo.** `.vital-memory/` and `.brief-cache/`
> are written at runtime; if they live inside the repo, Turbopack's file watcher goes into a
> recompile storm and the dev server OOMs (root-caused 2026-07-02).

### 3. Database

```bash
npx drizzle-kit migrate     # apply committed migrations to the local database
npx tsx scripts/seed-dev.ts # optional: seed a dev user / sample data
```

Schema changes always use migration files:

1. Update `db/schema.ts`.
2. Run `npx drizzle-kit generate`.
3. Review and commit the generated SQL plus `db/migrations/meta/_journal.json`
   (and its snapshot).
4. Test the migration against a local database with `npx drizzle-kit migrate`.

Production never uses `drizzle-kit push` (especially not `--force`). The
release workflow runs `npm run ci:migrate`, which validates the PostgreSQL URL,
applies only the committed `db/migrations/` journal through Drizzle's pinned
migrator, and verifies that the database migration table reaches the committed
journal head as the exact ordered, hash-matching prefix before deploying the
backend; missing, reordered, duplicate, or unknown rows fail the release.
`ci-migrate.mjs` also carries a guarded, one-time adoption path for the single
legacy production database that was advanced by schema pushes before the
Drizzle ledger existed — it verifies an exact schema snapshot match before
stamping, and never blindly stamps a database it doesn't recognize.

### 4. Run

```bash
npm run dev     # http://localhost:3000
```

The app is API-only: the surface is the JWT-gated `/api/*` routes used by the iOS app
(there is no web page at `/`). In development, middleware passes through and falls back to a
dev user (and strips any client-supplied `x-user-id` to prevent spoofing).

To run the proactive worker locally: `npm run worker` (or `npm run build:worker` first to
regenerate `dist/proactive-health-worker.cjs`). It needs the same `DATABASE_URL` plus all
four `APNS_*` vars.

---

## Testing

```bash
npm test    # node --import tsx --experimental-test-module-mocks --test
```

~787 tests, colocated as `*.test.ts` files next to the module they cover (e.g.
`lib/brain/recovery.test.ts` next to `lib/brain/recovery.ts`). This runs as a gate in the
`backend` job of `.github/workflows/release.yml` before the production build and deploy —
a failing test blocks the release.

---

## iOS app (`ios/Vital/`)

Native SwiftUI, project generated with **XcodeGen** (`.xcodeproj` is gitignored), signed and
shipped via **fastlane match**.

```bash
cd ios
brew install xcodegen
bundle install                       # fastlane + plugins
cp Vital/Sources/Core/Secrets.example.swift Vital/Sources/Core/Secrets.swift  # fill in API base URL + dev token
xcodegen generate                    # regenerate Vital.xcodeproj after any project.yml change
open Vital.xcodeproj
```

- **Health/** — `HealthKitManager`, `HealthKitBackfill` (365-day, resume-safe),
  `HealthSyncCoordinator` (background delivery).
- **Features/** — `Auth`, `Coach`, `Logging`, `Logs`, `Notifications`, `Onboarding`, `Profile`,
  `Today`, `Trends`. `Notifications` is the in-app notification inbox + nudge detail screen.
- **Core/** — `APIClient`, `NotificationManager`, `ProactiveNotifications`, `ReminderScheduler`,
  `SpeechTranscriber`, `KeychainStore`, `Units/`, `UserFacingError`, `ErrorCancellation`,
  `HealthAttributionLabel`, `Secrets`.
- **DesignSystem/** — ~20 native glassmorphic components, e.g. `GlassCard`, `VitalCard`,
  `MetricTile`, `Sparkline`, `CoachBubble`, `Chip`, `Toast`, `SkeletonView`, `ErrorCard`,
  `CautionBanner`, `Theme`.
- **Sign in with Apple is live** (`isSignInWithAppleEnabled = true` in `SignInView.swift`).
  DEBUG builds additionally show a "Dev sign-in" button (`#if DEBUG`) that authenticates
  against `DEV_AUTH_SECRET`.

---

## Deployment

Releases are **automatic on every push to `main`** via `.github/workflows/release.yml`
(see [CLAUDE.md](CLAUDE.md) for the full flow). In one workflow run it:

1. **version** — computes the next patch version from the latest `v*` tag and pushes it.
2. **backend** — runs the test suite (`npm test`) and a production build, then applies and
   verifies the committed Drizzle migrations against Supabase before `flyctl deploy` to
   Fly app `vital-coach`. The deploy ships **two Fly processes**: `app` (the Next.js API,
   behind `http_service`, volume-mounted) and `worker` (the proactive health worker,
   restart policy `always`, no volume).
3. **ios** — `xcodegen generate` + `fastlane beta` → uploads to TestFlight.

- **Backend** runs on **Fly.io** (not Vercel), with a persistent volume `vital_data` → `/data`
  (`VITAL_DATA_DIR=/data`), mounted only to the `app` process — the `worker` process has no
  volume. See `docs/fly-deploy.md`.
- **Database** is Supabase Postgres (Session pooler, port 5432).
- Required CI secrets are documented in `docs/CI-TESTFLIGHT.md`.

---

## Tech stack

- **iOS:** SwiftUI, HealthKit, XcodeGen, fastlane match → TestFlight
- **Backend:** Next.js 16.2.6 (App Router, TypeScript), React 19.2.4, deployed on Fly.io as
  **two processes** (`app` + `worker`)
- **Database:** Postgres (Supabase) via drizzle-orm 0.45.x + postgres.js — event-sourced
  ontology model, 26 tables
- **AI:** Anthropic `claude-sonnet-5` (`@anthropic-ai/sdk` ^0.95) — coach (tool-use + SSE),
  daily brief, proactive analysis, meal-photo Vision
- **Auth:** Sign in with Apple + session JWTs (`jose`)
- **Nutrition:** USDA FoodData Central + Open Food Facts (barcode) + CalorieNinjas (text
  fallback) + Claude Vision (photos)
- **Voice:** on-device speech-to-text + ElevenLabs TTS (falls back to the Apple voice)
- **Wearables:** WHOOP (OAuth + webhook sync)
- **Build/test tooling:** `sharp` (image processing), Tailwind v4, `esbuild` (worker bundle),
  `tsx`, `node:test`
- Custom glassmorphic design system on both surfaces (no UI library)
