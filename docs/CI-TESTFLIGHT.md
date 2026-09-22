# TestFlight release pipeline

Push a version tag → the backend is migrated + deployed to Fly, then the iOS app
is built and uploaded to TestFlight.

```bash
git tag v1.2.0
git push origin v1.2.0
```

(Or **Actions → Release → Run workflow** and enter a version manually.)

The workflow is `.github/workflows/release.yml`. The iOS lane is
`ios/fastlane/Fastfile` (`beta`). This doc covers the **one-time setup** — mostly
Apple + GitHub credentials only you can create.

---

## ⚠️ Prerequisite: Sign in with Apple must work in Release builds

TestFlight ships **Release** builds. The current only-working login, **Dev
sign-in, is `#if DEBUG` only**, and Sign in with Apple is disabled
(`isSignInWithAppleEnabled = false` in `SignInView.swift`). **A TestFlight
tester would have no way to log in.**

Before the first real tag, enable Sign in with Apple:

1. `SignInView.swift` → set `isSignInWithAppleEnabled = true`.
2. `ios/Vital/Sources/App/Vital.entitlements` → add:
   ```xml
   <key>com.apple.developer.applesignin</key>
   <array><string>Default</string></array>
   ```
   (and drop the "intentionally NOT added" note in `project.yml`).
3. Apple Developer portal → your App ID → enable the **Sign in with Apple**
   capability.
4. Fly backend → set `APPLE_BUNDLE_ID`:
   `flyctl secrets set APPLE_BUNDLE_ID=com.simantstha.vital`
   (the `/api/auth/apple` route verifies the identity token's audience against it).

---

## One-time setup

### 1. App record
Create the app in **App Store Connect → Apps → +** with bundle id
`com.simantstha.vital`. Fill the minimum metadata TestFlight requires.

### 2. App Store Connect API key (auth + upload)
App Store Connect → **Users and Access → Integrations → App Store Connect API →
+**. Role: **App Manager**. Download the `.p8` (once only). Record:
- **Key ID** → `ASC_KEY_ID`
- **Issuer ID** (top of the page) → `ASC_ISSUER_ID`
- base64 of the `.p8` → `ASC_KEY_CONTENT_BASE64`:
  ```bash
  base64 -i AuthKey_XXXX.p8 | pbcopy
  ```
- Your **Team ID** (Developer portal → Membership) → `APPLE_TEAM_ID`

### 3. Signing via fastlane match (one-time, run locally)
match keeps the distribution cert + provisioning profile in a **private git
repo**, encrypted. CI only reads it.

1. Create an **empty private repo**, e.g. `simantstha/vital-certs`.
2. From `ios/`, populate it once:
   ```bash
   cd ios
   bundle install
   MATCH_PASSWORD='<a-strong-passphrase>' \
   MATCH_GIT_URL='https://github.com/simantstha/vital-certs.git' \
   APPLE_TEAM_ID='<your-team-id>' \
     bundle exec fastlane match appstore \
       --api_key_path <(echo) # or sign in interactively
   ```
   This creates the Apple Distribution certificate + an App Store provisioning
   profile named `match AppStore com.simantstha.vital` and commits them
   (encrypted) to `vital-certs`.
3. For CI to clone that private repo, create a **fine-grained PAT** with read
   access to `vital-certs`, then:
   ```bash
   echo -n "simantstha:<PAT>" | base64      # → MATCH_GIT_BASIC_AUTHORIZATION
   ```

### 4. GitHub repo secrets
**Settings → Secrets and variables → Actions → New repository secret:**

| Secret | What |
|---|---|
| `FLY_API_TOKEN` | `flyctl tokens create deploy` |
| `SUPABASE_DATABASE_URL` | prod pooler URL (the `SUPABASE_DATABASE_URL` in `.env.local`) |
| `IOS_API_TOKEN` | value of `apiToken` in `Secrets.swift` (must equal Fly `DEV_AUTH_SECRET`) |
| `APPLE_TEAM_ID` | Developer portal Team ID |
| `ASC_KEY_ID` | API key ID |
| `ASC_ISSUER_ID` | API key issuer ID |
| `ASC_KEY_CONTENT_BASE64` | base64 of the `.p8` |
| `MATCH_GIT_URL` | `https://github.com/simantstha/vital-certs.git` |
| `MATCH_GIT_BASIC_AUTHORIZATION` | base64 of `user:PAT` |
| `MATCH_PASSWORD` | the match passphrase from step 3 |

The proactive notification worker additionally requires Fly runtime secrets
`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, and the full PEM-formatted
`APNS_PRIVATE_KEY`. These are Fly secrets, not GitHub Actions secrets; provision
them with the commands and formatting rules in `docs/fly-deploy.md` before the
release workflow deploys the worker.

---

## How versioning works
- **Marketing version** = the tag (`v1.2.0` → `1.2.0`), validated as `N.N[.N]`.
- **Build number** = highest build already on TestFlight + 1 (auto).
- Both are injected at archive time via `xcargs`; nothing to bump by hand.

## What CI does per run
1. **backend** job: runs backend tests and a production build, then executes
   `npm run ci:migrate` against Supabase before `flyctl deploy`. The migration
   gate accepts only a complete PostgreSQL `DATABASE_URL`, reads only committed
   `db/migrations/` files via the package-lock-pinned Drizzle migrator, and
   verifies every `drizzle.__drizzle_migrations` row is the exact ordered
   committed prefix through the journal head. Do not use `drizzle-kit push` or
   `--force` in production.

   One-time legacy adoption is narrowly limited to an exact committed `0000`
   ledger with expected target `0016_famous_sleepwalker`. Under a transaction
   and advisory lock, CI compares the live `public` catalog to the committed
   0016 snapshot—including all app tables, columns/types/nullability/defaults,
   PK/unique/check/FK constraints, indexes, RLS/policies, and unexpected public
   objects. Only an exact match allows CI to insert the committed 0001–0016
   hashes/timestamps, verify the adopted head, and continue with 0017+. A
   mismatch or any other stale/unknown ledger fails with operator guidance.
2. **ios** job (after backend): write `Secrets.swift`, `xcodegen generate`,
   `bundle exec fastlane beta` → archive → upload to TestFlight.

## Notes / gotchas
- The runner needs an Xcode with the SDK matching `deploymentTarget` in
  `project.yml`. If `latest-stable` is wrong, pin `xcode-version:` in the
  workflow to match your local Xcode.
- `skip_waiting_for_build_processing: true` — the job finishes at upload;
  Apple still needs a few minutes before the build appears for testers.
- Backend and app ship together by design. To decouple later, split the two
  jobs into separate workflows.

---

# Pull-request checks

`.github/workflows/pr-checks.yml` is separate from the release workflow above
— it runs on every pull request targeting `main` (and can be run manually via
**Actions → PR Checks → Run workflow**) so nothing merges uncompiled. It never
ships anything and **needs no repo secrets**.

Jobs, each gated by `dorny/paths-filter` so an unrelated change (e.g.
docs-only) skips the surface it didn't touch:

1. **changes** — detects whether the PR touched `ios/**` and/or the backend
   paths (same list `release.yml` uses: `app/**`, `lib/**`, `db/**`,
   `scripts/**`, `supabase/**`, `public/**`, plus the config files, plus the
   workflow file itself).
2. **backend** (ubuntu, if backend changed) — `npm ci`, `npm run lint`,
   `npm test`. No `DATABASE_URL` or other secret is needed; the test suite
   uses in-memory fakes, not a live database.
3. **ios** (macOS, if iOS changed) — `xcodegen generate` against a
   `Secrets.swift` synthesized with a dummy token (never a real secret, and
   no signing identity is configured), then builds the `Vital` scheme and
   runs the `VitalTests` unit tests on a dynamically-selected iPhone
   simulator (first available runtime ≥ iOS 26, matching
   `project.yml`'s `deploymentTarget`) with `CODE_SIGNING_ALLOWED=NO`. The
   `.xcresult` bundle is uploaded as a build artifact (7-day retention) on
   every run, pass or fail, for debugging.
4. **pr-checks** — a final `needs: [changes, backend, ios]`, `if: always()`
   job that fails if any of those came back `failure`/`cancelled` and passes
   if they succeeded or were skipped (path-filtered out). This is the one
   check name that exists on every run regardless of which paths changed, so
   it's the one to add under **Settings → Branches → Branch protection rules
   → main → Require status checks to pass → `pr-checks`**. Add the
   individual job names too only if you want a *required* iOS or backend
   check even when that surface wasn't touched — normally you don't, since
   they legitimately skip.

**Known gap:** `npx tsc --noEmit` is not part of the `backend` job yet — as of
this workflow's introduction it fails on `main` with 4 pre-existing type
errors in test files (`lib/streakRepository.test.ts`,
`lib/whoop/mapping.test.ts` ×2, `lib/whoop/sync.test.ts`), unrelated to any
change this workflow ships with. Fix those first, then add a
`npx tsc --noEmit` step to the `backend` job so the type-check stays green
from the day it's turned on.
