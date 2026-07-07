# Releasing (backend + iOS/TestFlight)

Releases are **tag-driven**. Pushing a `v*` tag runs `.github/workflows/release.yml`,
which (1) migrates the Supabase schema + deploys the backend to Fly, then
(2) builds the iOS app and uploads it to TestFlight. The build is cut from the
tagged commit, so the fix must already be on `main` first.

**Steps to ship a new build:**
1. Ensure the fix is merged to `main` via PR (the user merges — never merge or push to `main` directly).
2. Sync and confirm: `git checkout main && git pull --ff-only origin main && git log --oneline -5`
3. Pick the next version (bug-fix → bump patch; last tag was `v0.2.1`). Confirm it's free: `git rev-parse v0.2.2` should fail.
4. Tag the merge commit and push it:
   `git tag -a v0.2.2 -m "v0.2.2 — <summary>" && git push origin v0.2.2`
5. Watch it: `gh run list --workflow=release.yml --limit 1` then
   `gh run watch <run-id> --exit-status --interval 30`
6. Confirm both jobs (backend, iOS) are `success`:
   `gh run view <run-id> --json status,conclusion,jobs`

**Notes:**
- The marketing version comes from the tag name (`v0.2.2` → `0.2.2`); no VERSION file to bump.
- The workflow can also be run manually: Actions → Release → Run workflow (version without leading `v`).
- After a green run, Apple takes a few minutes to process the build before it shows in TestFlight.
- Required secrets are documented in `docs/CI-TESTFLIGHT.md`.

# gstack

## Web Browsing
Always use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

## Available gstack skills
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`
