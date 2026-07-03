# Handoff — auth/onboarding/backfill cycle BUILT, deploy + phone test pending

**Stacked PRs (merge in order, user merges):**
`main` ← **#5** `feat/ios-pivot-foundation` ← **#6** `feat/auth-multiuser` ← **#7** `feat/daily-metrics-baselines` ← **#8** `feat/coach-data-tools` ← **#9** `feat/healthkit-backfill` ← **#10** `feat/onboarding` ← **#11** `feat/calibrating-ux` ← **#12** `feat/background-sync`

**Backend:** live at https://vital-coach.fly.dev (Fly app `vital-coach`, ord, volume `vital_data`→`/data`; Supabase Postgres, Session pooler 5432 not 6543) — **still running the pre-cycle shared-secret build**; nothing from #6–#12 is deployed yet.
**Plan file:** `~/.claude/plans/hand-off-md-and-warm-cascade.md` (all 7 phases executed).

---

## ✅ What this cycle built (per-PR verification notes in each PR body)

1. **#6 Auth + per-user isolation** — session JWTs (jose), `POST /api/auth/apple` + env-gated
   `POST /api/auth/dev` (dev fallback until paid Apple Developer), JWT middleware sets verified
   `x-user-id`, every route per-user, memory files under `<DATA_DIR>/.vital-memory/<userId>/`
   (template-seeded). iOS: Keychain session, SignInView (SIWA flag-gated), RootView gate.
   3 security-review findings fixed. **The old phone barcode-scan failure was the AppSecrets ↔
   API_SHARED_SECRET mismatch — that whole mechanism is deleted by this PR.**
2. **#7 daily_metrics + baselines** — day-keyed upsert ingest (`/api/ingest/daily`, 60-day cap),
   baselines recomputed on ingest (7/30/60d stats, established ≥14 data days), `calibration`
   exposed on `/api/profile` + `/api/today`.
3. **#8 Coach data tools + tool-call UI** — 5 SQL query tools (metric trend / sleep / workouts /
   baseline / compare periods); time-series is tool-only (context trimmed); SSE `tool_call`
   events; iOS chat renders live activity rows → collapsed chips.
4. **#9 365-day HealthKit backfill** — daily aggregates for all 8 types, 30-day chunks,
   resume-safe via UserDefaults checkpoint, idempotent against the day-keyed upsert.
5. **#10 Onboarding** — 7-step flow (HealthKit-prefilled Basics → Goal → Training → Health →
   Lifestyle → CoachIntro in `mode:"onboarding"` → Calibrating w/ backfill progress);
   `POST /api/onboarding` template-fills per-user memory files, sets `users.onboarded_at`.
6. **#11 Calibrating state** — coach withholds recovery scores/prescriptions until HRV+RHR+sleep
   all established (verified live: declined a readiness verdict citing 5/14 days); Today shows
   the "Calibrating your baselines — N of 14 days" card.
7. **#12 Background sync** — `healthkit.background-delivery` entitlement, per-type observers +
   anchored queries (persisted anchors), touched-day re-aggregation → upsert; Today's raw
   delta-post path replaced by `syncNow()`.

**Full fresh-install simulator E2E passed**: dev sign-in → onboarding → calibrating screen →
tabs with calibrating card + insight. Two bugs found by the E2E, fixed on #12 (`a704363`):
- `/api/today` sends `null` metric values for fresh accounts; iOS decode was non-optional and
  silently dropped the whole payload (incl. calibration card). Now null-tolerant.
- Leaving onboarding CoachIntro mid-stream left the stream task + typing indicator alive;
  `CoachView.onDisappear` now cancels the stream.

---

## ⏭️ Deploy checklist (in order, production-affecting)

1. Merge PRs #5→#12 in stack order.
2. **Before `fly deploy`:** `fly secrets set SESSION_JWT_SECRET=$(openssl rand -hex 32) DEV_AUTH_SECRET=<value of AppSecrets.apiToken from ios/Vital/Sources/Core/Secrets.swift>` — middleware fails closed (503) without the JWT secret; DEBUG dev sign-in requires DEV_AUTH_SECRET == the iOS token.
3. `fly deploy --app vital-coach`, then run migrations against Supabase (`0001` onboarded_at, `0002` daily_metrics/baselines): `npx drizzle-kit migrate` with prod DATABASE_URL. (Local dev DB uses `push` — its migration journal is empty; prod should use `migrate`.)
4. Production reseed still pending from last cycle: `fly ssh console -a vital-coach -C "rm -rf /data/.vital-memory"` + machine restart — per-user dirs now reseed from `vital-memory-template/` on first access. Blast radius (weight log, streak, overrides) was user-approved.
5. **Phone test:** dev sign-in → onboarding (real HealthKit prefill) → 365-day backfill with real history → calibrating card with real N → coach cites real numbers via visible tool calls → log a workout, background the app, confirm new `daily_metrics` rows + advancing `baselines.computed_at` (background delivery is device-only).

## 📌 Known follow-ups

- `middleware.ts` → `proxy.ts` rename (Next 16 deprecation warning on every dev boot).
- SIWA: add entitlement + flip `isSignInWithAppleEnabled` in SignInView once paid Apple Developer exists.
- `app/api/nutrition/photo/route.ts`: `sharp(buf)` decompression-bomb hardening (`limitInputPixels` + body-size cap) — flagged pre-cycle, still open, low severity now that all routes sit behind per-user JWT auth.
- Local dev requires `VITAL_DATA_DIR` outside the repo (set in `.env.local` → `~/.vital-data`) — in-repo runtime writes put Turbopack's watcher into a recompile storm (load 400+, dev-server OOM; root-caused 2026-07-02).
- Local dev-user data contains E2E residue (Sim Tester onboarding, old chat history) — harmless; wipe `~/.vital-data/.vital-memory/<uuid>` + dev user rows to reset.

## ⚠️ Standing gotchas

- `Vital.xcodeproj` is gitignored/regenerated — run `xcodegen generate` after any `project.yml` edit.
- Supabase pooler: Session mode (5432), not 6543 (breaks postgres.js prepared statements).
- Full deploy runbook: `docs/fly-deploy.md`. Project memory: `ios-pivot-state`, `next-cycle-plan`.
