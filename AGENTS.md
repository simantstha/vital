# Codex Agent Instructions (vital)

**Read `AI_COMMON.md` first** — it holds the canonical shared project rules:
model-tier orchestration, PR discipline, and the release process. Everything
below is Codex-specific only.

## Model-Tier Mapping (orchestration rule)

Per the shared orchestration principle in `AI_COMMON.md`:
- The high-reasoning model/profile is the **orchestrator**: investigate, plan,
  write specs, review diffs — it must NOT write or edit code directly.
- Delegate actual code edits to a cheaper model or lower reasoning-effort
  profile (select via `codex -m <model>` / `--profile`, or a `[profiles.*]`
  entry in `~/.codex/config.toml`).
- The orchestrator reviews the resulting diff and verifies builds/tests before
  commit/PR.

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
