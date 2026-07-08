# Releasing (backend + iOS/TestFlight)

Releases are **automatic on every push to `main`**. `.github/workflows/release.yml`
has a `bump-tag` job that computes the next patch version from the latest `v*`
tag (e.g. `v0.2.1` → `v0.2.2`) and pushes it; that tag push then runs the
existing pipeline: (1) migrate the Supabase schema + deploy the backend to Fly,
then (2) build the iOS app and upload it to TestFlight.

**Steps to ship a new build:**
1. Merge the fix to `main` via PR (the user merges — never merge or push to `main` directly).
2. That merge's push to `main` auto-tags and kicks off the release — nothing else to do.
3. Watch it: `gh run list --workflow=release.yml --limit 2` (expect two runs: the
   `bump-tag`-only run for the main push, then the tag-triggered backend/ios run)
   then `gh run watch <run-id> --exit-status --interval 30`.
4. Confirm both jobs (backend, iOS) are `success`:
   `gh run view <run-id> --json status,conclusion,jobs`

**Notes:**
- The marketing version comes from the auto-bumped tag name (`v0.2.2` → `0.2.2`); no VERSION file to bump.
- To skip auto-tagging for a specific version (e.g. a minor/major bump), push that tag manually before merging, or use Actions → Release → Run workflow (version without leading `v`).
- After a green run, Apple takes a few minutes to process the build before it shows in TestFlight.
- Required secrets are documented in `docs/CI-TESTFLIGHT.md`; `bump-tag` additionally needs the default `GITHUB_TOKEN`'s `contents: write` permission (granted at the job level in the workflow).

# gstack

## Web Browsing
Always use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

## Available gstack skills
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`
