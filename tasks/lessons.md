# Lessons

- When proposing changes to an existing screen, derive mockups from the app's actual components, typography, spacing, and navigation. A matching palette alone is not design-system fidelity.
- Agent worktrees (`isolation: worktree`) are created from `origin/main`, not from the orchestrator's integration branch. Any delegated task that depends on unmerged work must first `git merge origin/<integration-branch>` in its worktree — say so in the prompt, or the agent rebuilds files from scratch and conflicts.
