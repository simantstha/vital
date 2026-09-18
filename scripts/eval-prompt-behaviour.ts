/**
 * Vital Brain — prompt behaviour evals
 *
 * Exercises the REAL prompt assembly (assemblePersona + BRAIN_TOOLS) against
 * the real Claude model and inspects which tool_use blocks come back. This is
 * the only place in the repo that verifies safety-critical prompt behaviour
 * — allergy capture, third-party fact attribution, retract-don't-duplicate —
 * against the model Claude actually is, rather than against a fake database.
 *
 * Design constraints (see docs/prompt-evals.md):
 *   - NEVER wired into `npm test` or CI. Run explicitly via `npm run eval:prompts`.
 *   - No database access: context is hand-built text, never assembleContext().
 *     (lib/brain/tools.ts does statically import '@/db' for its executor
 *     functions, but those executors are never called here — no query runs.)
 *   - No tool execution: we send the real tool definitions and read back
 *     tool_use blocks; the handlers in tools.ts are never invoked.
 *   - Makes real, billable Anthropic API calls.
 *
 * Usage:
 *   npm run eval:prompts
 *   EVAL_RUNS=3 npm run eval:prompts   # repeat each case 3x, report k/n
 *   EVAL_MODEL=claude-... npm run eval:prompts
 */

// Forces this file to be treated as an ES module (isolatedModules) instead of
// a global script — without a static import/export, `main` below would be a
// global symbol and collide with scripts/seed-dev.ts's own `async function
// main()`, which uses the same dynamic-import-only pattern.
export {};

async function main(): Promise<void> {
  // Load .env.local BEFORE importing anything that reads process.env at
  // module scope (lib/brain/anthropicClient.ts constructs its Anthropic
  // client at import time) — same ordering trick as scripts/seed-dev.ts.
  const { config } = await import('dotenv');
  config({ path: process.cwd() + '/.env.local', quiet: true });

  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  // Not used for any query — see the file header — but lib/brain/tools.ts
  // throws at import time if this is unset (db/index.ts's module-level
  // guard), so we need SOME value present to even load BRAIN_TOOLS.
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length > 0) {
    console.error(
      `eval:prompts: missing required configuration: ${missing.join(', ')}.\n` +
      `Set these in .env.local (see .env.example) before running this eval.`,
    );
    process.exitCode = 1;
    return;
  }

  const { client } = await import('../lib/brain/anthropicClient');
  const { assemblePersona } = await import('../lib/brain/persona');
  const { BRAIN_TOOLS } = await import('../lib/brain/tools');
  const { randomUUID } = await import('node:crypto');
  type OntologyNodeType = import('@/db/schema').OntologyNode;

  const MODEL = process.env.EVAL_MODEL ?? 'claude-sonnet-5'; // lib/brain/coach.ts:66
  const MAX_TOKENS = 512;
  const EVAL_RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? '1') || 1);

  // The exact tool-name allowlist the real coach turn attaches in
  // non-onboarding, non-specialist mode (lib/brain/coach.ts's baseTools) —
  // used both as the `tools` param below and as assemblePersona's
  // availableTools gate, so memoryCurationBlock renders identically to prod.
  const toolNames = BRAIN_TOOLS.map((t) => t.name);

  // ── Fixture helpers ─────────────────────────────────────────────────────

  function fakeNode(overrides: Partial<OntologyNodeType> & { type: string; label: string }): OntologyNodeType {
    return {
      id: randomUUID(),
      user_id: randomUUID(),
      properties: null,
      source: 'coach',
      weight: 0.9,
      created_at: new Date(),
      status: 'active',
      resolved_at: null,
      superseded_by: null,
      subject_node_id: null,
      ...overrides,
    } as OntologyNodeType;
  }

  const NOW_LOCAL = 'Thursday, September 17, 2026, 8:00 AM CDT';

  /** Minimal hand-built stand-in for context.ts's buildPromptText output —
   *  deliberately NOT calling the real (db-backed) assembleContext(). */
  function contextBlock(bodyLines: string[]): string {
    return [
      '## Vital Context',
      '',
      `### Today — ${NOW_LOCAL}`,
      '- No meals logged today yet',
      '',
      '### Schedule',
      '- No calendar synced yet',
      '',
      ...bodyLines,
    ].join('\n');
  }

  const ONBOARDING_CONTEXT = contextBlock([
    '### Baselines',
    'No baseline data yet — brand-new user, no history to compare against.',
    '',
    '### Calibration: calibrating',
    'Not yet established: HRV 0/14 days, resting heart rate 0/14 days, sleep 0/14 days. ' +
      'Avoid recovery scores or training prescriptions until calibration is ready — say so plainly if asked.',
    '',
    '### Ontology',
    'No hard constraints on file.',
    'GOALS & PREFERENCES:',
    '- Goal: Improve general fitness and energy levels (weight 0.90)',
  ]);

  const NORMAL_BASELINES = [
    '### Baselines',
    '- HRV (hrv_sdnn): 30-day avg 62, 45 days of data in the last 90d, established',
    '- Resting HR (resting_hr): 30-day avg 54, 45 days of data in the last 90d, established',
    '- Sleep (sleep_minutes): 30-day avg 420, 45 days of data in the last 90d, established',
    '',
    '### Calibration: ready',
  ];

  const NORMAL_CONTEXT_NO_FACTS = contextBlock([
    ...NORMAL_BASELINES,
    '',
    '### Ontology',
    'No hard constraints on file.',
  ]);

  // ── Tool-call assertion plumbing ────────────────────────────────────────

  interface ToolUse { name: string; input: Record<string, unknown> }

  interface Case {
    id: number;
    name: string;
    onboarding: boolean;
    hardConstraints: OntologyNodeType[];
    contextText: string;
    userMessage: string;
    check: (calls: ToolUse[]) => { pass: boolean; reason: string };
  }

  const hasCall = (calls: ToolUse[], name: string, pred?: (input: Record<string, unknown>) => boolean) =>
    calls.some((c) => c.name === name && (!pred || pred(c.input)));

  const cases: Case[] = [
    {
      id: 1,
      name: 'Allergy captured',
      onboarding: true,
      hardConstraints: [],
      contextText: ONBOARDING_CONTEXT,
      userMessage: "I'm allergic to peanuts.",
      check: (calls) => {
        const proposedAllergy = hasCall(calls, 'propose_fact', (i) => i.nodeType === 'Allergy');
        const rememberedAnything = hasCall(calls, 'remember_fact');
        return {
          pass: proposedAllergy && !rememberedAnything,
          reason: proposedAllergy
            ? (rememberedAnything ? 'propose_fact(Allergy) called, but remember_fact was ALSO called' : 'propose_fact(Allergy) called, no remember_fact')
            : 'no propose_fact(nodeType: Allergy) call found',
        };
      },
    },
    {
      id: 2,
      name: 'Allergy vs dislike',
      onboarding: true,
      hardConstraints: [],
      contextText: ONBOARDING_CONTEXT,
      userMessage: 'I really hate mushrooms.',
      check: (calls) => {
        const allergyRecorded =
          hasCall(calls, 'propose_fact', (i) => i.nodeType === 'Allergy') ||
          hasCall(calls, 'remember_fact', (i) => i.nodeType === 'Allergy');
        return {
          pass: !allergyRecorded,
          reason: allergyRecorded ? 'an Allergy fact was recorded for a stated dislike' : 'no Allergy fact recorded (FoodPreference or no call both pass)',
        };
      },
    },
    {
      id: 3,
      name: 'No allergy invented',
      onboarding: true,
      hardConstraints: [],
      contextText: ONBOARDING_CONTEXT,
      userMessage: 'Nope, no allergies at all.',
      check: (calls) => {
        const allergyRecorded =
          hasCall(calls, 'propose_fact', (i) => i.nodeType === 'Allergy') ||
          hasCall(calls, 'remember_fact', (i) => i.nodeType === 'Allergy');
        return {
          pass: !allergyRecorded,
          reason: allergyRecorded ? 'an Allergy fact was invented despite an explicit denial' : 'no Allergy fact recorded',
        };
      },
    },
    {
      id: 4,
      name: 'Third-party attribution',
      onboarding: false,
      hardConstraints: [],
      contextText: NORMAL_CONTEXT_NO_FACTS,
      userMessage: 'My father was diagnosed with type 2 diabetes last year.',
      check: (calls) => {
        const withSubject = calls.find(
          (c) => c.name === 'remember_fact' && typeof c.input.subject === 'string' && /father|dad/i.test(c.input.subject as string),
        );
        const rememberedNoSubject = calls.find((c) => c.name === 'remember_fact' && !withSubject);
        return {
          pass: !!withSubject,
          reason: withSubject
            ? `remember_fact carried subject="${withSubject.input.subject}"`
            : rememberedNoSubject
              ? 'remember_fact called but WITHOUT a subject naming the father — safety regression'
              : 'no remember_fact call found at all',
        };
      },
    },
    {
      id: 5,
      name: "Retract, don't duplicate",
      onboarding: false,
      hardConstraints: [fakeNode({ type: 'Injury', label: 'Torn ACL', weight: 0.9 })],
      contextText: contextBlock([
        ...NORMAL_BASELINES,
        '',
        '### Ontology',
        'HARD CONSTRAINTS (never violate):',
        '- Injury: Torn ACL (weight 0.90)',
      ]),
      userMessage: 'My ACL is fully healed now.',
      check: (calls) => {
        const resolved = hasCall(calls, 'resolve_fact');
        const remembered = hasCall(calls, 'remember_fact');
        return {
          pass: resolved && !remembered,
          reason: resolved
            ? (remembered ? 'resolve_fact called, but remember_fact was ALSO called (duplicate)' : 'resolve_fact called, no remember_fact')
            : 'no resolve_fact call found',
        };
      },
    },
    {
      id: 6,
      name: 'Entity read',
      onboarding: false,
      hardConstraints: [],
      contextText: contextBlock([
        ...NORMAL_BASELINES,
        '',
        '### Ontology',
        'No hard constraints on file.',
        'GOALS & PREFERENCES:',
        '- Condition: Type 2 diabetes (weight 0.90) (about: Father)',
        '',
        '### People & entities',
        '- Father (Person) — 1 fact',
      ]),
      userMessage: 'What do you know about my father?',
      check: (calls) => {
        const read = hasCall(calls, 'read_entity');
        return { pass: read, reason: read ? 'read_entity called' : 'no read_entity call found' };
      },
    },
  ];

  // ── Runner ───────────────────────────────────────────────────────────────

  function formatCall(c: ToolUse): string {
    return `${c.name}(${JSON.stringify(c.input)})`;
  }

  let anyCaseFailed = false;
  let totalRuns = 0;
  let totalPassed = 0;

  for (const testCase of cases) {
    console.log(`\n=== Case ${testCase.id}: ${testCase.name} ===`);
    const system = assemblePersona(
      testCase.hardConstraints,
      undefined,
      testCase.onboarding,
      undefined,
      'metric',
      toolNames,
    );

    let runsPassed = 0;
    for (let run = 1; run <= EVAL_RUNS; run++) {
      totalRuns++;
      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          thinking: { type: 'disabled' },
          system,
          tools: BRAIN_TOOLS,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: testCase.contextText },
                { type: 'text', text: `\n\n---\n\nUser: ${testCase.userMessage}` },
              ],
            },
          ],
        });

        const calls: ToolUse[] = response.content
          .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
          .map((b) => ({ name: b.name, input: b.input as Record<string, unknown> }));

        const { pass, reason } = testCase.check(calls);
        if (pass) { runsPassed++; totalPassed++; }

        console.log(`Run ${run}/${EVAL_RUNS}: ${pass ? 'PASS' : 'FAIL'} — ${reason}`);
        if (calls.length > 0) {
          for (const c of calls) console.log(`  tool_use: ${formatCall(c)}`);
        } else {
          console.log('  tool_use: (none)');
        }
      } catch (err) {
        console.log(`Run ${run}/${EVAL_RUNS}: FAIL — API error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const caseFailed = runsPassed !== EVAL_RUNS;
    if (caseFailed) anyCaseFailed = true;
    console.log(`Result: ${runsPassed}/${EVAL_RUNS} passed ${caseFailed ? '[CASE FAILED]' : '[CASE PASSED]'}`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`${cases.length} cases, ${totalPassed}/${totalRuns} total runs passed.`);
  console.log(anyCaseFailed
    ? 'One or more cases did not pass on every run — prompt behaviour regressed (or is flaky). See detail above.'
    : 'All cases passed on every run.');

  process.exitCode = anyCaseFailed ? 1 : 0;
}

void main();
