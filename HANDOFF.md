# Handoff — Fly.io deploy + phone install

**Goal:** deploy the Vital Next.js backend to Fly.io (with Supabase Postgres +
shared-secret auth) so the iOS app talks to a hosted server, then install the
app on a physical iPhone.

**Branch:** `feat/ios-pivot-foundation` → **PR #5** (private repo `simantstha/vital`).
**Status as of 2026-06-30:** **Deployed and verified.** Live at https://vital-coach.fly.dev.
Supabase project `vital-coach` (ref `roupsepzvxbxchnrlxpn`, us-east-2) holds the DB; schema
migrated; Fly app `vital-coach` (region `ord`) running with volume `vital_data`. `/api/health`
returns `{"ok":true}`, unauthenticated `/api/today` returns 401, authenticated returns JSON.
Remaining step: **phone install** (see below).

---

## ✅ Done (committed)

- **Container:** `Dockerfile` (Next `output:'standalone'`), `.dockerignore`,
  `scripts/docker-entrypoint.sh` (seeds `/data/.vital-memory` on first boot).
- **Fly config:** `fly.toml` — app `vital-coach`, region `ord`, volume
  `vital_data`→`/data`, `/api/health` check, auto-suspend.
- **Persistence fix:** backend does runtime file I/O to `.vital-memory/` +
  `.brief-cache/` (ephemeral on Fly). `lib/dataDir.ts` `DATA_DIR` (= `VITAL_DATA_DIR`
  || cwd) routes it to the volume; touched `lib/coachState|memory|weightLog|briefCache|claude.ts`.
  Local dev unaffected when `VITAL_DATA_DIR` is unset.
- **Auth:** `middleware.ts` gates `/api/*` behind `Authorization: Bearer <API_SHARED_SECRET>`.
  Fails **closed** in production if the secret is unset; fail-open only in local
  dev; constant-time token compare; `/api/health` exempt.
- **iOS:** `APIClient.swift` → `https://vital-coach.fly.dev`, bearer token set
  per-request + redirect delegate strips it on cross-host redirects. Token lives
  in **gitignored** `ios/Vital/Sources/Core/Secrets.swift` (`AppSecrets.apiToken`);
  template `ios/Vital/Secrets.example.swift`.
- **Build fix:** framer-motion `Variants` type error in untracked `app/mockup/page.tsx`.
- **Runbook:** `docs/fly-deploy.md`.

---

## ✅ Blockers — resolved 2026-06-30

1. ~~Log into Fly~~ — done, `fly auth login` as `simant_stha@hotmail.com`.
2. ~~Create Supabase DB~~ — done, project `vital-coach` (ref `roupsepzvxbxchnrlxpn`,
   us-east-2). Session-mode connection string saved as `SUPABASE_DATABASE_URL` in
   `.env.local` (gitignored). Supabase CLI also installed (`brew install supabase/tap/supabase`)
   and a Supabase MCP server is registered (local scope, read-only, project-pinned) for
   future DB inspection — needs a fresh Claude Code session to pick up its tools.

---

## ✅ Deploy checklist — completed 2026-06-30

```bash
# 1. Migrated schema onto Supabase
DATABASE_URL="$SUPABASE_DATABASE_URL" npx drizzle-kit migrate   # 7 tables created

# 2. Created the Fly app + volume
fly apps create vital-coach
fly volumes create vital_data --app vital-coach --region ord --size 1 --yes

# 3. Set secrets (DATABASE_URL=$SUPABASE_DATABASE_URL, API_SHARED_SECRET from
#    Secrets.swift apiToken, plus Anthropic/Whoop/Strava/MFP/CalorieNinjas/v0 keys)
fly secrets set --app vital-coach ...

# 4. Deployed via Fly's remote (Depot) builder — no local Docker needed
fly deploy --app vital-coach

# 5. Verified
curl https://vital-coach.fly.dev/api/health                 # {"ok":true} ✅
curl -i https://vital-coach.fly.dev/api/today               # 401 ✅ (auth works)
curl -s https://vital-coach.fly.dev/api/today -H "Authorization: Bearer $SECRET"  # JSON ✅
```

---

## 📱 Phone install (separate from Fly; no $99 account needed for personal use)

1. `cd ios/Vital && xcodegen generate` (picks up the new gitignored
   `Sources/Core/Secrets.swift`), then open `Vital.xcodeproj` in Xcode.
2. Plug in the iPhone, select it as the run destination.
3. Signing & Capabilities → set **Team** (a free Apple ID = 7-day personal
   provisioning; paid Apple Developer Program for TestFlight/longer).
4. Build & Run. The app hits the Fly backend.

---

## ⚠️ Gotchas / notes

- **Web dashboard `/`** fetches `/api/*` from the browser without the token →
  shows error states against the deployed backend. Expected; the iOS app is the client.
- **App name** `vital-coach` must be globally unique on Fly. If taken, change it
  in `fly.toml` *and* `APIClient.swift` `apiBaseURL`.
- **Supabase pooler:** must use **Session mode (5432)**. The 6543 transaction
  pooler breaks postgres.js prepared statements without `prepare: false`.
- **`middleware.ts`** triggers a Next 16 deprecation warning ("use proxy")—it
  still works in 16.2.6. Optional future cleanup: rename to `proxy.ts`.
- **Secret** is committed nowhere; it's only in the gitignored `Secrets.swift`
  locally. Back it up if you wipe the working tree.
- Full reference: `docs/fly-deploy.md`. Project memory: `ios-pivot-state` memory file.
