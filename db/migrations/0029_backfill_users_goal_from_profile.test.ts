import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/**
 * db/migrations/0029_backfill_users_goal_from_profile.sql back-fills
 * users.goal by regex-extracting "- Primary: <id>" out of core_profile_md's
 * "## Active Goals" section, then mapping it through the same 8-value CASE
 * (4 onboarding ids + 4 canonical ids) as lib/brain/dietBudget.ts's
 * goalFromOnboarding.
 *
 * IMPORTANT — what this test does and does not prove:
 *   This environment has no pglite/test-Postgres in devDependencies, and the
 *   sandbox's own policy blocks the local auth changes needed to reach the
 *   system's Postgres 16 install (attaching a role to connect as would
 *   require weakening pg_hba.conf, which the harness's auto-mode classifier
 *   refuses as a "Security/TLS-Auth weaken" action — verified by trying).
 *   So the actual .sql file's substring()/CASE statements were NEVER
 *   executed against a real PostgreSQL engine.
 *
 *   Instead, `extractActiveGoalsSection` and `extractPrimaryId` below are
 *   hand-ports of the migration's two `substring(x from '...')` regex calls,
 *   kept byte-for-byte comment-annotated against the SQL patterns they
 *   mirror. JS's regex engine and Postgres's ARE (Advanced Regular
 *   Expression) engine both support non-greedy `*?`, and `[\s\S]` reproduces
 *   Postgres's non-newline-sensitive default (dot matches newline) without
 *   needing JS's `s` flag — so a match here is strong evidence the SQL
 *   pattern behaves the same way, but it is evidence, not proof: any
 *   ARE/PCRE-family divergence in edge-case backtracking would not be
 *   caught by this test.
 *   The goal-id -> DietGoal mapping step, in contrast, reuses the real
 *   production goalFromOnboarding (lib/brain/dietBudget.ts) directly, so
 *   that half of the pipeline IS exercised as real app code.
 */

// dietBudget.ts (transitively, via lib/brain/tools.ts and
// lib/coreProfileStore.ts) imports '@/db', which throws at import time if
// DATABASE_URL is unset — same constraint documented in dietBudget.test.ts.
// Mocked here purely so `import('@/lib/brain/dietBudget')` doesn't throw;
// goalFromOnboarding itself makes no db/memory calls.
mock.module('@/db', { namedExports: { db: {}, schema: {} } });
mock.module('@/lib/memory', { namedExports: { readMemoryFile: () => null } });

const dietBudgetPromise = import('../../lib/brain/dietBudget');

/**
 * Mirrors:
 *   substring(core_profile_md from '## Active Goals(.*?)(?:## |$)')
 * Postgres's regex engine is non-newline-sensitive by default (`.` matches
 * newlines, `$` anchors to the end of the whole string, not per line).
 * `[\s\S]` (rather than a dotAll `.`) reproduces the same "matches any
 * character including newline" behavior without needing the `s` regex flag,
 * which this repo's ES2017 tsc target rejects on a regex literal; no `m`
 * flag is used so `$` stays whole-string here too, matching Postgres's
 * default.
 */
function extractActiveGoalsSection(coreProfileMd: string | null): string | null {
  if (coreProfileMd == null) return null;
  const m = /## Active Goals([\s\S]*?)(?:## |$)/.exec(coreProfileMd);
  return m ? m[1] : null;
}

/** Mirrors: substring(section_text from '- Primary: *([A-Za-z_]+)') */
function extractPrimaryId(sectionText: string | null): string | null {
  if (sectionText == null) return null;
  const m = /- Primary: *([A-Za-z_]+)/.exec(sectionText);
  return m ? m[1] : null;
}

function coreProfile(opts: { activeGoalsPrimary: string; fitnessActivitiesPrimary?: string; lastSection?: boolean }): string {
  const lines = [
    '# Vital — Core Profile',
    '',
    '## Identity',
    '- Age: 34',
    '- Sex: female',
    '- Height: 165 cm',
    '- Current weight: 62 kg — last updated 2026-01-01',
    '',
    '## Active Goals',
    `- Primary: ${opts.activeGoalsPrimary}`,
    '- Secondary: Not specified yet',
    '- Weekly training target: 4',
    '',
  ];
  if (!opts.lastSection) {
    lines.push(
      '## Fitness Activities',
      `- Primary: ${opts.fitnessActivitiesPrimary ?? 'running'}`,
      '- Secondary: Not specified yet',
      '',
    );
  }
  return lines.join('\n');
}

const BLANK_TEMPLATE = [
  '## Active Goals',
  '- Primary: [to be filled]',
  '- Secondary: [to be filled]',
  '',
  '## Fitness Activities',
  '- Primary: [to be filled]',
  '',
].join('\n');

for (const [onboardingId, canonical] of [
  ['lose_fat', 'weight_loss'],
  ['build_muscle', 'muscle'],
  ['improve_endurance', 'endurance'],
  ['general_health', 'general'],
] as const) {
  test(`extracts and maps pre-fix onboarding id "${onboardingId}" -> ${canonical}`, async () => {
    const { goalFromOnboarding } = await dietBudgetPromise;
    const md = coreProfile({ activeGoalsPrimary: onboardingId });

    const section = extractActiveGoalsSection(md);
    assert.ok(section, 'expected an Active Goals section to be extracted');
    const rawId = extractPrimaryId(section);
    assert.equal(rawId, onboardingId);
    assert.equal(goalFromOnboarding(rawId!), canonical);
  });
}

test('does not leak Fitness Activities\' own unrelated "- Primary:" line as the goal', async () => {
  const md = coreProfile({ activeGoalsPrimary: 'lose_fat', fitnessActivitiesPrimary: 'running' });

  const section = extractActiveGoalsSection(md);
  assert.doesNotMatch(section ?? '', /running/, 'section must be cut off before Fitness Activities');
  assert.equal(extractPrimaryId(section), 'lose_fat');
});

test('a canonical DietGoal id already in the profile passes through unchanged', async () => {
  const { goalFromOnboarding } = await dietBudgetPromise;
  const md = coreProfile({ activeGoalsPrimary: 'endurance' });

  const rawId = extractPrimaryId(extractActiveGoalsSection(md));
  assert.equal(rawId, 'endurance');
  assert.equal(goalFromOnboarding(rawId!), 'endurance');
});

test('a still-blank "[to be filled]" template extracts no usable id', async () => {
  const section = extractActiveGoalsSection(BLANK_TEMPLATE);
  assert.ok(section, 'section itself is found');
  // "[to be filled]" starts with "[", outside [A-Za-z_], so no id matches —
  // mirrors the migration leaving goal untouched (still NULL) for never-
  // onboarded rows.
  assert.equal(extractPrimaryId(section), null);
});

test('free text the coach wrote is captured but rejected by the CASE whitelist', async () => {
  const { goalFromOnboarding } = await dietBudgetPromise;
  const md = coreProfile({ activeGoalsPrimary: 'Train for a marathon' });

  // [A-Za-z_]+ stops at the first non-letter (the space), same as Postgres.
  const rawId = extractPrimaryId(extractActiveGoalsSection(md));
  assert.equal(rawId, 'Train');
  // Not one of the 8 CASE branches -> goalFromOnboarding returns null ->
  // the migration's UPDATE ... WHERE raw_goal IN (...) excludes this row.
  assert.equal(goalFromOnboarding(rawId!), null);
});

test('Active Goals as the last section (no trailing "## ") still extracts via the end-of-string fallback', async () => {
  const md = coreProfile({ activeGoalsPrimary: 'build_muscle', lastSection: true });
  assert.doesNotMatch(md, /## Fitness Activities/);

  const rawId = extractPrimaryId(extractActiveGoalsSection(md));
  assert.equal(rawId, 'build_muscle');
});

test('a profile with no Active Goals section at all extracts nothing', async () => {
  const md = ['## Identity', '- Age: 30', ''].join('\n');
  assert.equal(extractActiveGoalsSection(md), null);
});

test('null core_profile_md (never-onboarded row) extracts nothing', async () => {
  assert.equal(extractActiveGoalsSection(null), null);
});
