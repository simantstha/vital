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

---

## How versioning works
- **Marketing version** = the tag (`v1.2.0` → `1.2.0`), validated as `N.N[.N]`.
- **Build number** = highest build already on TestFlight + 1 (auto).
- Both are injected at archive time via `xcargs`; nothing to bump by hand.

## What CI does per run
1. **backend** job: `drizzle-kit push` to Supabase, then `flyctl deploy`.
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
