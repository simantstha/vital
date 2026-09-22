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
4. **ios-screenshots** (macOS, if iOS changed) — builds `VitalScreenshots`
   (its own scheme, separate from `Vital`, so this never slows down the
   `ios` job above) and runs `VitalUITests` against every fixture scenario in
   both light and dark, then publishes the PNGs. See **iOS screenshot
   harness** below for how it works and where the images land. Screenshot
   *publishing* is best-effort (`continue-on-error`) — only a real build/test
   failure in this job fails `pr-checks`.
5. **pr-checks** — a final `needs: [changes, backend, ios, ios-screenshots]`,
   `if: always()` job that fails if any of those came back
   `failure`/`cancelled` and passes if they succeeded or were skipped
   (path-filtered out). This is the one check name that exists on every run
   regardless of which paths changed, so it's the one to add under
   **Settings → Branches → Branch protection rules → main → Require status
   checks to pass → `pr-checks`**. Add the individual job names too only if
   you want a *required* iOS or backend check even when that surface wasn't
   touched — normally you don't, since they legitimately skip.

**Known gap:** `npx tsc --noEmit` is not part of the `backend` job yet — as of
this workflow's introduction it fails on `main` with 4 pre-existing type
errors in test files (`lib/streakRepository.test.ts`,
`lib/whoop/mapping.test.ts` ×2, `lib/whoop/sync.test.ts`), unrelated to any
change this workflow ships with. Fix those first, then add a
`npx tsc --noEmit` step to the `backend` job so the type-check stays green
from the day it's turned on.

---

## iOS screenshot harness

A cloud-container orchestrator (no simulator, can't compile Swift) still
needs to *see* the app. The `ios-screenshots` PR-checks job renders every
main screen, in every scenario, in light and dark, and publishes the PNGs
somewhere a `git fetch` can reach — no TestFlight build or device required.

### How fixture mode works

Everything lives behind `#if DEBUG` in `ios/Vital/Sources/Fixtures/` and is
compiled out of Release entirely (zero behavior change for a real
build/TestFlight/App Store user):

- **`FixtureMode.swift`** — parses the `-VitalFixture <scenario>` launch
  argument into a `Scenario` case. `FixtureMode.isActive` is `false` (and
  everything below is a no-op) under any normal launch.
- **`AuthViewModel.init()`** — when fixture mode is active, skips real Sign in
  with Apple / dev sign-in and lands the app signed-in (via the same
  `KeychainStore`/`AppRouter` calls a real sign-in makes, with a fake session
  token), onboarded unless the scenario is `onboarding`.
- **Permission guards** — `HealthKitManager.requestAuthorization()`,
  `NotificationManager.requestPermission()`,
  `CalendarEventsProvider.requestAccess()`, and
  `SpeechTranscriber.requestPermissions()` all short-circuit under fixture
  mode, so no system permission alert can ever pop up and block
  `XCUIScreen.main.screenshot()` (XCUITest doesn't dismiss those on its own).
- **`FixtureURLProtocol.swift`** — a `URLProtocol` registered process-wide
  (`URLProtocol.registerClass`, from `AppDelegate`) the moment fixture mode is
  active. It intercepts every request to the app's own backend host —
  `APIClient`'s dedicated session, `URLSession.shared`, and every other
  `.default`-configuration session alike — and answers from `FixtureData`
  instead. A request to any other host (e.g. WHOOP's OAuth page) is left
  alone, since no fixture scenario ever triggers one.
- **`FixtureData.swift`** — one `Profile` per scenario (goal, insight copy,
  plan/meals, weight/HRV/sleep/steps baselines) and a `response(scenario:
  method:path:query:)` that builds the exact JSON shape each
  `APIClient.swift` endpoint's `Decodable` type expects. The `server_error`
  scenario short-circuits everything to a 500 regardless of path.

### Scenarios

| Scenario | What it shows |
| --- | --- |
| `new_user` | Fresh account, no data yet — Today's calibrating state, empty plan/insight |
| `weight_loss` | Established weight-loss account — a week of meals, downward weight trend, full plan, brief coach insight |
| `muscle` | Established muscle-gain account |
| `endurance` | Established endurance account, with a logged run |
| `server_error` | Every endpoint 500s — exercises every screen's error state |
| `onboarding` | Signed in but not onboarded — the onboarding questionnaire instead of the tab UI |

### Adding a scenario

1. Add a case to `FixtureMode.Scenario`.
2. Add a matching `Profile` to `FixtureData.profiles` (or special-case it in
   `FixtureData.response` the way `.serverError`/`.onboarding` are).
3. Add a `test_<scenario>()` method to `ScreenshotTests` (or extend
   `runScreenshots`'s scenario list if it becomes table-driven later).

### Where screenshots land

`VitalUITests` (scheme `VitalScreenshots`, kept separate from the `Vital`
scheme so the fast unit-test job never runs it) navigates to Today, the diet
logging sheet, Coach, Trends, Logs, and Profile per scenario/appearance, and
attaches each as an `XCTAttachment` named
`<scenario>__<screen>__<light|dark>`.

The `ios-screenshots` job exports those attachments from the `.xcresult`
bundle (`xcrun xcresulttool export attachments`) and pushes the renamed PNGs
to the `ci-screenshots` branch (an orphan branch holding nothing but
screenshots) at:

```
pr-<PR number>/<short sha>/<scenario>__<screen>__<light|dark>.png
```

`git fetch origin ci-screenshots` then a checkout/browse gets you the images
without a simulator. They're also uploaded as a same-run build artifact
(`ios-screenshots`, 30-day retention) for the PR author to download directly
— the only path available for a fork PR, since publishing to
`ci-screenshots` is skipped there (a fork can't be granted `contents: write`
on this repo).
