@AI_COMMON.md

## Model Orchestration — Claude Tier Mapping (Non-Negotiable)

Per the shared orchestration principle in `AI_COMMON.md`: the smart/expensive
model (Opus, Fable) MUST NOT write or edit code directly. Orchestration only —
investigate, diagnose, read code, write specs. Delegate all actual code edits
to a subagent:
- **Haiku agent**: 1–3 file changes, CSS/UI tweaks, simple routes, mechanical edits
- **Sonnet agent**: schema + migration + backend + frontend together, complex logic, AI features

Review the subagent's diff, verify it builds/tests, then commit/PR. The
orchestrating model may only run read-only tools (Read, Grep, git status,
builds/tests) and delegate writes. It must not call Edit/Write on source
files itself.

# gstack

## Web Browsing
Always use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

## Available gstack skills
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`
