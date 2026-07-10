# Vital

A personal AI health & marathon-training coach. A **native iOS app** (SwiftUI) syncs your
Apple Health data to a Next.js + Postgres backend, where an AI coach reasons over your
training load, recovery, sleep, and nutrition — and talks to you in a chat that can read
your real time-series data, log meals, and remember facts about you.

Built for training toward the Twin Cities Marathon (Oct 4, 2026).

> **History:** Vital started as a fullscreen web kiosk dashboard fed by Whoop/Strava/MyFitnessPal
> with a Telegram bot. It has since pivoted to a native iOS app backed by Apple HealthKit.
> The old web dashboard has since been removed; the Next.js app is now API-only.

---

## Architecture

```
┌─────────────────────────┐        HTTPS / JWT        ┌──────────────────────────────┐
│  iOS app (SwiftUI)       │ ───────────────────────► │  Next.js API  (Fly.io)        │
│  • HealthKit sync         │   POST /api/ingest/daily │  • JWT-gated /api/* routes    │
│  • Onboarding             │   GET  /api/today,trends │  • lib/brain coach engine     │
│  • Coach chat (SSE)       │   POST /api/coach (SSE)  │  • lib/claude daily brief     │
│  • Meal photo logging     │                          │                               │
└─────────────────────────┘                          └───────────┬──────────────────┘
                                                                  │
                                          ┌───────────────────────┴───────────────────┐
                                          │  Postgres (Supabase)   +   .vital-memory/  │
                                          │  events, nodes/edges,      per-user         │
                                          │  daily_metrics, baselines, markdown/JSON    │
                                          │  messages, pending_facts   coach memory     │
                                          └────────────────────────────────────────────┘
```

- **Structured / quantitative data** (HealthKit aggregates, chat history, the ontology of
  facts about you) lives in **Postgres** (`db/schema.ts`, drizzle-orm).
- **Qualitative / narrative coach memory** (profile, coach notes) lives in per-user
  **`.vital-memory/<userId>/`** markdown+JSON files, seeded from `vital-memory-template/`.
- The coach reads time-series only through **tools** (`lib/brain/tools.ts`) so raw data
  never bloats the prompt.

---

## What it does

**iOS app** (the primary product surface)
- Syncs Apple Health data — HRV, resting HR, sleep, steps, active energy, body mass,
  workouts — including a resume-safe 365-day historical backfill and live background sync.
- 7-step onboarding (Basics → Goal → Training → Health → Lifestyle → Coach intro → Calibrating).
- **Coach chat** over SSE, with live tool-call chips as the coach queries your data.
- Meal photo logging (Claude Vision estimates macros) and barcode/food search.
- **Calibrating state:** the coach withholds recovery verdicts and prescriptions until it
  has ≥14 days of established baselines for HRV, resting HR, and sleep.

**Backend** (`app/api/*`)
- Multi-user, JWT-authenticated (Sign in with Apple; dev sign-in in DEBUG builds).
- AI coach loop (`lib/brain/coach.ts`) using Anthropic tool-use, streamed as SSE.
- Daily brief generation (`lib/claude.ts`).
- Nutrition: Open Food Facts (barcode) + CalorieNinjas (text search) + Claude Vision (photos).

---

## Repository layout

```
app/
  api/                  # The real backend. Key routes:
    auth/{apple,dev}/     # Sign in with Apple + env-gated dev sign-in → session JWT
    coach/                # Coach chat (SSE, streaming tool-use loop)
    coach/opener/         # Generates a fresh chat opener
    ingest/daily/         # HealthKit day-keyed aggregate upsert → daily_metrics
    today/ trends/ logs/  # Read models for the iOS Today / Trends / Logs tabs
    onboarding/           # Writes per-user memory files, sets users.onboarded_at
    profile/              # Profile + calibration state
    meals/{log,modify,recipe}/   # Interactive meal plan
    nutrition/{barcode,search,photo}/  # OFF / CalorieNinjas / Claude Vision
    pending-facts/        # Confirmation-gated learning queue
    brief/ weight-log/ health/
  globals.css           # Glassmorphic design system

lib/
  brain/                # Postgres-era coach engine
    coach.ts              # runCoach() — multi-turn streaming tool-use loop, persists to Postgres
    tools.ts              # Tool inventory (query_events, get_metric_trend, log_meal, remember_fact, …)
    context.ts            # Deterministic context assembled from Postgres
    persona.ts            # System prompt (constraints, calibration state, onboarding mode)
    baselines.ts          # Baseline stats + "established" gating
    brief.ts briefCache.ts
  claude.ts             # generateDailyBrief() — JSON daily brief
  auth.ts               # SIWA verification (jose), session JWT issue/verify
  memory.ts             # Per-user file-based narrative memory (tool seam)
  dataDir.ts            # Resolves .vital-memory / .brief-cache root (VITAL_DATA_DIR)
  nutritionix.ts        # CalorieNinjas food lookup (file name is a legacy misnomer)
  openFoodFacts.ts      # Barcode lookup
  coachState.ts weightLog.ts types.ts

db/                     # drizzle-orm schema + migrations (Postgres)
middleware.ts           # Edge JWT gate for /api/* (fails closed 503 in prod w/o SESSION_JWT_SECRET)

ios/Vital/              # Native SwiftUI app (see ios/ section below)

vital-memory-template/  # Per-user memory seed files (baked into the Docker image)

docs/                   # vital-architecture-v0.1.md, CI-TESTFLIGHT.md, fly-deploy.md, …
```

---

## Backend — local development

### 1. Install dependencies

```bash
npm install
```

### 2. Environment (`.env.local`)

```env
# Anthropic
ANTHROPIC_API_KEY=

# Postgres (local dev DB, or a Supabase Session-pooler URL — port 5432, NOT 6543)
DATABASE_URL=postgres://user:pass@localhost:5432/vital

# Auth
SESSION_JWT_SECRET=        # openssl rand -hex 32 — middleware fails closed (503) without it in prod
DEV_AUTH_SECRET=           # dev sign-in token; must match the iOS DEBUG token
APPLE_BUNDLE_ID=           # audience checked when verifying Sign in with Apple tokens

# Nutrition
CALORIENINJAS_API_KEY=     # text food search (lib/nutritionix.ts)

# Data directory — MUST point OUTSIDE the repo (see warning below)
VITAL_DATA_DIR=/Users/you/.vital-data
```

> ⚠️ **`VITAL_DATA_DIR` must be outside the repo.** `.vital-memory/` and `.brief-cache/`
> are written at runtime; if they live inside the repo, Turbopack's file watcher goes into a
> recompile storm and the dev server OOMs (root-caused 2026-07-02).

### 3. Database

```bash
npx drizzle-kit push        # local dev: push schema directly
npx tsx scripts/seed-dev.ts # optional: seed a dev user / sample data
```

(Production uses `drizzle-kit migrate` against the tracked migrations in `db/`.)

### 4. Run

```bash
npm run dev     # http://localhost:3000
```

The app is API-only: the surface is the JWT-gated `/api/*` routes used by the iOS app
(there is no web page at `/`). In development, middleware passes through and falls back to a
dev user (and strips any client-supplied `x-user-id` to prevent spoofing).

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

- **Health/** — `HealthKitManager`, `HealthKitBackfill` (365-day, resume-safe), `HealthSyncCoordinator` (background delivery).
- **Features/** — `Auth`, `Onboarding`, `Today`, `Trends`, `Logs`, `Coach`, `Logging`, `Profile`.
- **DesignSystem/** — native glassmorphic components (`GlassCard`, `Chip`, `CoachBubble`, `MetricTile`).
- Sign in with Apple is currently flag-disabled; DEBUG builds use dev sign-in against `DEV_AUTH_SECRET`.

---

## Deployment

Releases are **automatic on every push to `main`** via `.github/workflows/release.yml`
(see [CLAUDE.md](CLAUDE.md) for the full flow). In one workflow run it:

1. **version** — computes the next patch version from the latest `v*` tag and pushes it.
2. **backend** — `drizzle-kit push` against Supabase, then `flyctl deploy` to Fly app `vital-coach`.
3. **ios** — `xcodegen generate` + `fastlane beta` → uploads to TestFlight.

- **Backend** runs on **Fly.io** (not Vercel), with a persistent volume `vital_data` → `/data`
  (`VITAL_DATA_DIR=/data`). See `docs/fly-deploy.md`.
- **Database** is Supabase Postgres (Session pooler, port 5432).
- Required CI secrets are documented in `docs/CI-TESTFLIGHT.md`.

---

## Tech stack

- **iOS:** SwiftUI, HealthKit, XcodeGen, fastlane match → TestFlight
- **Backend:** Next.js 16 (App Router, TypeScript), deployed on Fly.io
- **Database:** Postgres (Supabase) via drizzle-orm + postgres.js — event-sourced ontology model
- **AI:** Anthropic `claude-sonnet-4-6` — coach (tool-use + SSE), daily brief, meal-photo Vision
- **Auth:** Sign in with Apple + session JWTs (jose)
- **Nutrition:** Open Food Facts (barcode) + CalorieNinjas (search)
- Custom glassmorphic design system on both surfaces (no UI library)