# Codex Agent Instructions (vital)

**Read `AI_COMMON.md` first** — it holds the canonical shared project rules:
model-tier orchestration, PR discipline, and the release process. Everything
below is Codex-specific only.

## Model Orchestration (Non-Negotiable)

The orchestrator models in this repo are:

- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.5`
- `gpt-5.5-pro`

When acting as orchestrators, these models MUST investigate, diagnose, plan,
delegate implementation, review the worker diff, and run verification. They
MUST NOT directly edit files or write repository code.

The implementation models in this repo are:

- `gpt-5.3-codex`
- `gpt-5.1-codex-mini`

When delegated work, these models may write code and modify files.

## Required Project Workflow

- When a bug or error is reported, explain the root cause before acting.
- Never merge directly to `main`.
- Never push directly to `main`.
- Always work on a feature branch.
- Use conventional commit messages.
- Push the feature branch.
- Open a pull request against `main`.
- Stop after opening the PR so the user can review and merge it.

## Tooling Notes

- The project-level `supabase` MCP server (`.codex/config.toml`) is
  **read-only by design** — do not attempt writes through it. Schema changes go
  through drizzle migrations in `db/migrations/` and ship via the release
  workflow.
- No browser automation exists in this environment (Claude-only `/browse` and
  claude-in-chrome are unavailable). If a task requires live browsing, state
  the limitation instead of improvising.
- Claude-only skills (gstack `/…` commands, claude-mem, vercel-plugin skills)
  do not exist here — never claim to invoke them.
- Verification: `npm run build`, project tests, and `gh run` / `gh pr` for CI
  status.
