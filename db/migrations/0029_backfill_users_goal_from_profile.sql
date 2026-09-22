-- Custom SQL migration file, put your code below! ---------------------------
--
-- Backfill users.goal from the free-text core-profile.md "## Active Goals"
-- section for users who onboarded before app/api/onboarding/route.ts wrote
-- users.goal directly (see lib/brain/dietBudget.ts's goalFromOnboarding).
-- Before that fix, onboarding wrote basics.goal only into core-profile.md's
-- "- Primary: <id>" line and left users.goal NULL, so the diet budget
-- (lib/brain/dietBudget.ts's normalizeGoal) silently fell back to 'general'
-- (maintenance calories) for these users until they separately re-picked in
-- Profile > Goal.
--
-- Scope: only rows where users.goal IS NULL — never touch anyone who already
-- has a goal, whether set by the fixed onboarding route, Profile > Goal, or
-- the coach. Pure UPDATE, no DDL: additive-safe, no column/constraint
-- changes, safe to run while old and new app code are both live.
--
-- Extraction is regex-scoped to the "## Active Goals" section specifically:
-- core-profile.md also has a "## Fitness Activities" section with its own,
-- unrelated "- Primary: <activity>" line (e.g. "- Primary: running"), and
-- reading that as a goal would silently write nonsense. The non-greedy
-- `(.*?)` capture stops at the next "## " heading (or end of string, for a
-- profile that was ever truncated or hand-edited so Active Goals is last).
--
-- PostgreSQL's regex engine is non-newline-sensitive by default — `.`
-- matches newlines and `$` anchors to the end of the whole string, not per
-- line (see "Regular Expression Details" in the PostgreSQL docs) — so no
-- inline (?s)/(?m) flags are needed for either substring() below.
--
-- Recognised values: the four raw iOS onboarding ids this bug actually wrote
-- (OnboardingFlowView.swift: lose_fat | build_muscle | improve_endurance |
-- general_health) plus the four canonical DietGoal ids (GoalDetailView.swift
-- / lib/brain/dietBudget.ts's DIET_GOALS: weight_loss | muscle | endurance |
-- general), in case a profile line was ever hand-edited to already use them.
-- Anything else — free text the coach later wrote into that line, or a
-- still-blank "[to be filled]" template placeholder — does not match any CASE
-- branch, so those rows are left with goal untouched (still NULL), same as
-- today.
WITH active_goals_section AS (
  SELECT
    id,
    substring(core_profile_md from '## Active Goals(.*?)(?:## |$)') AS section_text
  FROM users
  WHERE goal IS NULL
    AND core_profile_md IS NOT NULL
    AND core_profile_md ~ '## Active Goals'
),
primary_goal AS (
  SELECT
    id,
    substring(section_text from '- Primary: *([A-Za-z_]+)') AS raw_goal
  FROM active_goals_section
  WHERE section_text IS NOT NULL
)
UPDATE users
SET goal = CASE primary_goal.raw_goal
  WHEN 'lose_fat'          THEN 'weight_loss'
  WHEN 'build_muscle'      THEN 'muscle'
  WHEN 'improve_endurance' THEN 'endurance'
  WHEN 'general_health'    THEN 'general'
  WHEN 'weight_loss'       THEN 'weight_loss'
  WHEN 'muscle'            THEN 'muscle'
  WHEN 'endurance'         THEN 'endurance'
  WHEN 'general'           THEN 'general'
END
FROM primary_goal
WHERE users.id = primary_goal.id
  AND primary_goal.raw_goal IN (
    'lose_fat', 'build_muscle', 'improve_endurance', 'general_health',
    'weight_loss', 'muscle', 'endurance', 'general'
  );
