# Shared AI Agent Rules (canonical)

Tool-agnostic project rules shared by every coding agent working in this repo.
Tool-specific adapters:
- `CLAUDE.md` (Claude Code) — imports this file natively via `@AI_COMMON.md`.
- `AGENTS.md` (Codex CLI) — instructs the agent to read this file first.

Keep shared rules HERE. Only tool-specific mappings and tooling notes belong in
the adapter files.

## Model-Tier Orchestration (Non-Negotiable)

The highest-tier / most expensive model MUST NOT write or edit code directly.
Its role is orchestration only:
- Investigate, diagnose root causes, and read code
- Plan the change and write specs / problem docs
- Delegate all actual code edits to a cheaper tier/model
- Review the delegate's diff, verify it builds/tests, then commit/PR

The orchestrating model may only run read-only tools (file reads, grep,
git status, builds/tests) and delegate writes. Each adapter file maps this
principle to its tool's actual model tiers.

## Database Migrations (Non-Negotiable)

Two production incidents came from bypassing migration files (2026-07-09
schema drift outage; 2026-07-12 `messages` table truncated). The rules:

- **NEVER run `drizzle-kit push` against the production database** — from any
  agent, tool, or terminal, with or without `--force`. `push` diffs
  `db/schema.ts` against the live DB and ignores committed migration files and
  their backfills entirely; `--force` auto-accepts data-loss resolutions
  (that is what truncated `messages`). `push` is for local dev databases only.
- Every schema change ships as a generated migration file: edit `db/schema.ts`,
  run `npx drizzle-kit generate`, commit the new file under `db/migrations/`
  (add hand-written backfill statements to that file when a column needs
  populating before a NOT NULL or CHECK lands).
- Production migrations are applied ONLY by `scripts/ci-migrate.mjs` in the
  release workflow. It fails the deploy loudly on a bad `DATABASE_URL` or if
  the applied head doesn't match the journal — never weaken or bypass that
  verification to "unblock" a release.
- A PR that both changes the schema and adds code reading the new columns must
  keep the migration additive-safe: assume old code runs against the new
  schema during the deploy window.

## Pull Request Discipline

Never push directly to `main` and never merge PRs. Always:
1. Create a feature branch: `feat/<short-description>`
2. Commit with a conventional commit message
3. Push and open a PR against `main` via `gh pr create`
4. Stop there — the user reviews and merges.

# Releasing (backend + iOS/TestFlight)

Releases are **automatic on every push to `main`**. `.github/workflows/release.yml`
has a `version` job that computes the next patch version from the latest `v*`
tag (e.g. `v0.2.1` → `v0.2.2`) and pushes it as a tag, then runs `backend` and
`ios` in that *same* workflow run — (1) migrate the Supabase schema + deploy
the backend to Fly, then (2) build the iOS app and upload it to TestFlight.
(The tag push from `version` does not itself trigger a second run — GitHub
Actions suppresses runs triggered by the default `GITHUB_TOKEN` — so
everything must happen in one run rather than chaining off the tag push.)

**Steps to ship a new build:**
1. Merge the fix to `main` via PR (the user merges — never merge or push to `main` directly).
2. That merge's push to `main` auto-tags and runs the full release in one workflow run — nothing else to do.
3. Watch it: `gh run list --workflow=release.yml --limit 1` then
   `gh run watch <run-id> --exit-status --interval 30`.
4. Confirm all three jobs (version, backend, iOS) are `success`:
   `gh run view <run-id> --json status,conclusion,jobs`

**Notes:**
- The marketing version comes from the auto-bumped tag name (`v0.2.2` → `0.2.2`); no VERSION file to bump.
- To ship a specific minor/major version instead of the next patch, push that tag manually, or use Actions → Release → Run workflow (version without leading `v`) — either skips the auto-bump.
- After a green run, Apple takes a few minutes to process the build before it shows in TestFlight.
- Required secrets are documented in `docs/CI-TESTFLIGHT.md`; the `version` job additionally needs the default `GITHUB_TOKEN`'s `contents: write` permission (granted at the job level in the workflow).
