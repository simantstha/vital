# Handoff — bug-fix cycle done, deploy + phone test pending

**Branch:** `feat/ios-pivot-foundation` → **PR #5** (private repo `simantstha/vital`).
**Backend:** live at https://vital-coach.fly.dev (Fly app `vital-coach`, region `ord`,
volume `vital_data`→`/data`; Supabase Postgres `roupsepzvxbxchnrlxpn`, us-east-2).
**Plan file:** `~/.claude/plans/analyze-recent-developments-and-luminous-duckling.md`

---

## ✅ Done this session (committed + pushed to PR #5)

Six commits, top of branch = `97688ff`:

1. `fix(nutrition):` **committed the deployed-but-uncommitted `sharp` photo fix** — git
   now matches production. (Prod had been running code absent from git since Jun 30.)
2. `feat(coach):` warmer conversational persona (MAX_TOKENS 1500→2500) + web layout fonts.
3. `chore:` tracked `CLAUDE.md`/`HANDOFF.md`/`docs/`/`app/mockup/`; gitignored local scratch
   (`.claude/`, `.playwright-mcp/`, `v0-output/`, v0 scripts, `supabase/.temp/`, tsbuildinfo).
4. `fix(ios):` **clear 6 Xcode warnings** — `TARGETED_DEVICE_FAMILY=1` (iPhone-only), removed
   `ENABLE_PREVIEWS`, migrated 5 `.onChange(of:){_ in}` → zero-param form. Build verified 6→0.
5. `fix(ios):` **stop rendering fake data** — Today/Profile VMs seeded neutral zeros (HRV 0,
   name "", avatar "?"), `isLoading` spinner gates, error surfacing, name-free greeting,
   URLSession caching disabled. iOS build clean.
6. `fix(backend):` **decouple seed template** — new tracked `vital-memory-template/` (genericized
   profiles; HRV sentinel `- HRV baseline: 0ms (updated never)` verified against both regexes in
   `lib/claude.ts:121,129`); cleaned duplicate `SEED_PROFILE`; `Dockerfile` seeds from template;
   `.vital-memory/` gitignored + dockerignored + `git rm --cached` (files kept on disk for local dev).

**Verified locally:** `npx tsc --noEmit` clean, `npm run build` succeeds, iOS `xcodebuild` 0 warnings.
Docker not available locally, so the fresh-seed container sim was deferred to the real deploy.

---

## ⏭️ Next: two deploy actions (production-affecting — run these first)

**1. Production reseed** — wipe the dirty live volume so it reseeds from the clean template:
```bash
fly deploy --app vital-coach
fly ssh console -a vital-coach -C "rm -rf /data/.vital-memory"
fly machine restart <machine-id> -a vital-coach   # or let auto_stop/auto_start cycle it
# verify:
fly ssh console -a vital-coach -C "cat /data/.vital-memory/core-profile.md"   # placeholders, no "Twin Cities"
curl -s https://vital-coach.fly.dev/api/today -H "Authorization: Bearer $SECRET"  # 200 + well-formed
```
Blast radius note: `rm -rf /data/.vital-memory` clears the whole dir incl. `weight-log.json`,
`overrides.json`, `green-streak.json` (intended clean slate, user-confirmed).

**2. Physical iPhone install** — the plan's end-to-end proof:
- `cd ios/Vital && xcodegen generate`, open `Vital.xcodeproj` in Xcode.
- Plug in iPhone, select as run destination, Signing & Capabilities → set **Team** (free Apple ID
  = 7-day provisioning), Build & Run.
- Confirm: Today/Profile show a **spinner first, never a flash of fake numbers**, then real/empty state.
- Token lives in gitignored `ios/Vital/Sources/Core/Secrets.swift` (`AppSecrets.apiToken`).

---

## 🔒 Open follow-up (flagged, not scoped)

Background security review flagged `app/api/nutrition/photo/route.ts`: `sharp(buf)` is a potential
**decompression-bomb / unbounded allocation**. Low severity (endpoint is auth-gated behind the
shared-secret middleware; sharp has a default input-pixel limit). Fix if desired: explicit
`sharp(buf, { limitInputPixels: ... })` + max base64/body-size guard. User was asked whether to
harden now or defer to the auth cycle — **awaiting answer.**

---

## 🚀 Next cycle (designed, not started): Sign-in-with-Apple + per-user isolation

User decision: bug-fix first (this session), auth next. This is what restores the personalization
Part B temporarily dropped (name in greeting). Readiness audit (memory obs 2453) found:
- **DB ready** — `users.apple_sub` (nullable, unique) + `user_id` FKs on all data tables. No schema change.
- **Backend work** — middleware JWT verification (replace static shared-secret), new `/api/auth/apple`
  route (issue session JWT via existing unused `jsonwebtoken` dep), replace ~10-11 `getOrCreateDevUser()`
  call sites (in `app/api/{today,coach,logs,profile,trends,meals/log,pending-facts,pending-facts/resolve,
  ingest,brief}`) with header-derived userId; thread `userId` through file-state modules
  (`lib/memory.ts`/`claude.ts`/`weightLog.ts`/`coachState.ts`) → per-user `.vital-memory` paths;
  unify the two brief caches (`lib/briefCache.ts` global vs `lib/brain/briefCache.ts` per-user).
- **iOS work** — add `com.apple.developer.applesignin` to `Vital.entitlements`; `KeychainStore`;
  `SignInView` + `AuthViewModel` (post identityToken to `/api/auth/apple`); `RootView` gate between
  `SignInView`/`RootTabView`; swap `APIClient` static token → runtime Keychain token.
- Existing `dev@vital.local` data abandoned (no migration); delete `getOrCreateDevUser()` after.

---

## ⚠️ Gotchas / notes

- **Local `.vital-memory/` still holds dirty dev-session content** (Twin Cities etc.) — expected, it's
  now untracked/dockerignored so it can't ship. The clean template is `vital-memory-template/`.
- `Vital.xcodeproj` is gitignored/regenerated — run `xcodegen generate` after any `project.yml` edit.
- **Supabase pooler:** Session mode (5432), not 6543 (breaks postgres.js prepared statements).
- `middleware.ts` triggers a Next 16 "use proxy" deprecation warning — still works; optional cleanup.
- Full deploy runbook: `docs/fly-deploy.md`. Project memory: `ios-pivot-state`.
