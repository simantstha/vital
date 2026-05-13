# Vital Coach Long-Term Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vital coach's single flat `user-profile.md` with a structured multi-file memory system where Claude reads and writes its own memory via tool_use, covering health conditions, training history, nutrition habits, and life context.

**Architecture:** `lib/memory.ts` owns all memory file I/O and exports Claude tool definitions. `lib/telegramCoach.ts` runs a tool_use agentic loop so Claude can fetch domain files on demand and write back what it learns. Always-loaded files (core profile, health conditions, coach observations, index) stay in the system prompt; domain files are fetched only when relevant.

**Tech Stack:** Next.js 16, `@anthropic-ai/sdk ^0.95.1` (tool_use), TypeScript, Node.js `fs` (file-based, same as current — Vercel KV migration is a separate task)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `lib/memory.ts` | All memory I/O helpers + Claude tool definitions |
| Modify | `lib/telegramCoach.ts` | Tool_use agentic loop + new context loading |
| Modify | `lib/claude.ts` | Sport-agnostic brief prompt + HRV baseline drift |
| Create | `.vital-memory/memory-index.md` | Manifest of all domain files |
| Create | `.vital-memory/core-profile.md` | Migrated from user-profile.md |
| Create | `.vital-memory/coach-observations.md` | Migrated Coach Notes section |
| Create | `.vital-memory/health-conditions.json` | Allergies, conditions, medications |
| Create | `.vital-memory/training-history.json` | PRs, achievements, injuries, training notes |
| Create | `.vital-memory/nutrition-habits.json` | Food preferences, GI triggers, supplements |
| Create | `.vital-memory/life-context.json` | Stress events, travel, motivation patterns |

---

## Task 1: Create `lib/memory.ts`

**Files:**
- Create: `lib/memory.ts`

This is the foundation everything else depends on. It owns all file I/O and exports the tool definitions the Anthropic SDK needs.

- [ ] **Step 1: Create `lib/memory.ts`**

```typescript
import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.resolve(process.cwd(), '.vital-memory');

const ALLOWED_FILES = [
  'memory-index.md',
  'core-profile.md',
  'coach-observations.md',
  'health-conditions.json',
  'training-history.json',
  'nutrition-habits.json',
  'life-context.json',
] as const;

type MemoryFile = typeof ALLOWED_FILES[number];

function memoryPath(filename: MemoryFile): string {
  return path.join(MEMORY_DIR, filename);
}

export function readMemoryFile(filename: string): string | null {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return null;
  try {
    return fs.readFileSync(memoryPath(filename as MemoryFile), 'utf-8');
  } catch {
    return null;
  }
}

export function writeMemoryFile(filename: string, content: string): void {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return;
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(memoryPath(filename as MemoryFile), content, 'utf-8');
  } catch { /* read-only fs on Vercel */ }
}

export function appendObservation(note: string): void {
  const file = memoryPath('coach-observations.md');
  const date = new Date().toISOString().split('T')[0];
  const entry = `- [${date}] ${note}`;
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    content = '# Coach Observations\n\n';
  }
  // Collect existing entries, prepend new one, keep last 30
  const lines = content.split('\n').filter(l => l.startsWith('- ['));
  lines.unshift(entry);
  const trimmed = lines.slice(0, 30);
  const updated = '# Coach Observations\n\n' + trimmed.join('\n') + '\n';
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(file, updated, 'utf-8');
  } catch { /* read-only fs */ }
}

/** Always-loaded context: index + core profile + health conditions + observations */
export function loadAlwaysOnContext(): string {
  const index = readMemoryFile('memory-index.md') ?? '';
  const core = readMemoryFile('core-profile.md') ?? '';
  const conditions = readMemoryFile('health-conditions.json') ?? '{}';
  const observations = readMemoryFile('coach-observations.md') ?? '';

  return [
    '## Memory Index\n' + index,
    '## Core Profile\n' + core,
    '## Health Conditions (SAFETY — always follow these)\n```json\n' + conditions + '\n```',
    observations,
  ].join('\n\n---\n\n');
}

/** Tool definitions for the Anthropic tool_use API */
export const MEMORY_TOOLS = [
  {
    name: 'read_memory',
    description:
      'Read a memory file by name. Check memory-index.md first to know what each file contains, then fetch domain files only when relevant to the current message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          enum: ALLOWED_FILES,
          description: 'The memory file to read.',
        },
      },
      required: ['filename'],
    },
  },
  {
    name: 'write_memory',
    description:
      'Overwrite a structured JSON memory file with updated content. Use when you learn a new fact (injury, food preference, PR, allergy, supplement, stress event, travel). Always read the file first, merge the new fact, then write the full updated content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          enum: ['health-conditions.json', 'training-history.json', 'nutrition-habits.json', 'life-context.json', 'core-profile.md'],
          description: 'The memory file to overwrite.',
        },
        content: {
          type: 'string',
          description: 'Full updated file content (JSON string for .json files, markdown for .md).',
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'append_observation',
    description:
      'Append a short, dated coaching insight to coach-observations.md. Use after noticing a pattern, trend, or anything worth remembering about this user that does not fit a structured field. Keep it under 20 words.',
    input_schema: {
      type: 'object' as const,
      properties: {
        note: {
          type: 'string',
          description: 'The observation to append (under 20 words).',
        },
      },
      required: ['note'],
    },
  },
] as const;

export function handleToolCall(name: string, input: unknown): string {
  const inp = input as Record<string, string>;
  if (name === 'read_memory') {
    return readMemoryFile(inp.filename) ?? `File "${inp.filename}" not found.`;
  }
  if (name === 'write_memory') {
    writeMemoryFile(inp.filename, inp.content);
    return 'Memory updated.';
  }
  if (name === 'append_observation') {
    appendObservation(inp.note);
    return 'Observation appended.';
  }
  return 'Unknown tool.';
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/simantstha/Documents/Playground/vital && npx tsc --noEmit
```

Expected: no errors from `lib/memory.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/memory.ts
git commit -m "feat: add memory.ts — file I/O helpers and Claude tool definitions"
```

---

## Task 2: Seed `.vital-memory/` files

**Files:**
- Create: `.vital-memory/memory-index.md`
- Create: `.vital-memory/core-profile.md`
- Create: `.vital-memory/coach-observations.md`
- Create: `.vital-memory/health-conditions.json`
- Create: `.vital-memory/training-history.json`
- Create: `.vital-memory/nutrition-habits.json`
- Create: `.vital-memory/life-context.json`

The existing `user-profile.md` is replaced by `core-profile.md` (goals/baselines) and `coach-observations.md` (coach notes). Keep `user-profile.md` in place temporarily until `lib/claude.ts` is updated in Task 4.

- [ ] **Step 1: Create `.vital-memory/memory-index.md`**

```markdown
# Memory Index

- core-profile.md: identity, active goals, fitness activities, adaptive baselines (HRV/RHR/recovery/weight)
- coach-observations.md: rolling dated coach notes — patterns, trends, insights about this user
- health-conditions.json: allergies, medical conditions, medications, dietary restrictions (SAFETY — always follow)
- training-history.json: PRs, past race/event achievements, injury log, training notes
- nutrition-habits.json: food preferences, GI triggers, pre-workout meals, supplements, eating patterns
- life-context.json: stress events, travel log, motivation patterns, general notes
```

- [ ] **Step 2: Create `.vital-memory/core-profile.md`**

Seed with the user's known data (update fields in brackets to match actual values):

```markdown
# Vital — Core Profile

## Identity
- Age: [age]
- Sex: male
- Height: [height]
- Current weight: [weight] — last updated 2026-05-13

## Active Goals
- Primary: Twin Cities Marathon, October 4 2026
- Secondary: [e.g., reach target weight by August]

## Fitness Activities
- Primary: running
- Secondary: gym / strength training

## Baselines — auto-updated by coach
- HRV baseline: 65ms (updated 2026-05-13)
- Resting HR: 49 bpm
- Recovery baseline: 72%
- Weight trend: tracking
```

- [ ] **Step 3: Create `.vital-memory/coach-observations.md`**

Seed with any existing coach notes from the old `user-profile.md`. If no notes exist yet, create the file empty:

```markdown
# Coach Observations

```

- [ ] **Step 4: Create `.vital-memory/health-conditions.json`**

```json
{
  "allergies": [],
  "conditions": [],
  "medications": [],
  "dietaryRestrictions": [],
  "coachInstructions": []
}
```

- [ ] **Step 5: Create `.vital-memory/training-history.json`**

```json
{
  "PRs": {
    "5K": null,
    "10K": null,
    "halfMarathon": null,
    "marathon": null
  },
  "achievements": [],
  "injuries": [],
  "trainingNotes": []
}
```

- [ ] **Step 6: Create `.vital-memory/nutrition-habits.json`**

```json
{
  "preferences": [],
  "GITriggers": [],
  "preWorkoutMeals": [],
  "supplements": [],
  "patterns": []
}
```

- [ ] **Step 7: Create `.vital-memory/life-context.json`**

```json
{
  "stressEvents": [],
  "travelLog": [],
  "motivationPatterns": [],
  "generalNotes": []
}
```

- [ ] **Step 8: Commit**

```bash
git add .vital-memory/memory-index.md .vital-memory/core-profile.md .vital-memory/coach-observations.md \
  .vital-memory/health-conditions.json .vital-memory/training-history.json \
  .vital-memory/nutrition-habits.json .vital-memory/life-context.json
git commit -m "feat: seed vital-memory domain files for long-term coach memory"
```

---

## Task 3: Update `lib/telegramCoach.ts` — tool_use agentic loop

**Files:**
- Modify: `lib/telegramCoach.ts`

Replace the single `client.messages.create` call in `processMessage` with a tool_use loop. Also update `buildSystemPrompt` to use `loadAlwaysOnContext()` instead of `readUserProfile()`.

- [ ] **Step 1: Add imports to `lib/telegramCoach.ts`**

Add at the top of the file (after existing imports):

```typescript
import { loadAlwaysOnContext, MEMORY_TOOLS, handleToolCall } from '@/lib/memory';
```

Remove the existing import of `readUserProfile` from `@/lib/claude`:

```typescript
// Remove this line:
import { readUserProfile } from '@/lib/claude';
```

- [ ] **Step 2: Replace `buildSystemPrompt` in `lib/telegramCoach.ts`**

Replace the existing `buildSystemPrompt` function:

```typescript
function buildSystemPrompt(alwaysOnMemory: string, healthCtx: string): string {
  return `You are Vital Coach — a personal fitness and nutrition AI coach.
You respond via Telegram. Keep answers SHORT and direct (under 120 words) unless the user asks for detail.

You have access to memory tools. On each message:
1. Decide if you need more context from a domain file — check the Memory Index, then call read_memory if needed.
2. Answer the user.
3. If you learned a new fact (injury, food reaction, PR, allergy, supplement, travel, stress event), call write_memory to update the relevant file. Always read the file first, merge the new fact, then write the full updated JSON.
4. If you noticed a pattern or insight worth remembering, call append_observation (under 20 words).

NEVER display tool calls or memory operations to the user. They are silent background actions.

## Long-term Memory
${alwaysOnMemory}

## Today's Health Context
${healthCtx}`;
}
```

- [ ] **Step 3: Replace the `client.messages.create` call in `processMessage` with a tool_use loop**

In `processMessage`, replace this block:

```typescript
const userProfile = readUserProfile();
const healthCtx = await buildHealthContext();
const systemPrompt = buildSystemPrompt(userProfile, healthCtx);
```

With:

```typescript
const alwaysOnMemory = loadAlwaysOnContext();
const healthCtx = await buildHealthContext();
const systemPrompt = buildSystemPrompt(alwaysOnMemory, healthCtx);
```

Then replace the final `client.messages.create` call (the one that produces `msg`) with this tool_use loop:

```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

// (add this import at the top of the file alongside other imports)
```

And replace the `client.messages.create` block at the bottom of `processMessage`:

```typescript
const messages: MessageParam[] = [{ role: 'user', content: userContent }];

let response = await client.messages.create({
  model: 'claude-opus-4-5',
  max_tokens: 1024,
  system: systemPrompt,
  tools: [...MEMORY_TOOLS],
  messages,
});

// Agentic loop — run until Claude stops calling tools
while (response.stop_reason === 'tool_use') {
  messages.push({ role: 'assistant', content: response.content });

  const toolResults = response.content
    .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
    .map(block => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: handleToolCall(block.name, block.input),
    }));

  messages.push({ role: 'user', content: toolResults });

  response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: systemPrompt,
    tools: [...MEMORY_TOOLS],
    messages,
  });
}

const raw = response.content.find((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')?.text ?? '';
```

The rest of the function (action parsing, Telegram reply) stays unchanged.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/simantstha/Documents/Playground/vital && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/telegramCoach.ts
git commit -m "feat: telegramCoach tool_use agentic loop for on-demand memory reads/writes"
```

---

## Task 4: Update `lib/claude.ts` — sport-agnostic prompt + HRV baseline drift

**Files:**
- Modify: `lib/claude.ts`

Two changes: (1) make the brief generation prompt sport-agnostic by reading goals from `core-profile.md` instead of hardcoding "marathon runner", and (2) after generating a brief, check if the 7-day HRV avg has drifted >3ms from the stored baseline and update `core-profile.md` if so.

- [ ] **Step 1: Add import to `lib/claude.ts`**

Add at the top:

```typescript
import { readMemoryFile, writeMemoryFile } from '@/lib/memory';
```

- [ ] **Step 2: Replace `readUserProfile` usage in `generateDailyBrief`**

In `generateDailyBrief`, replace:

```typescript
const userProfile = readUserProfile();
```

With:

```typescript
const userProfile = readMemoryFile('core-profile.md') ?? readUserProfile();
```

This falls back to the old `user-profile.md` if `core-profile.md` doesn't exist yet.

- [ ] **Step 3: Replace the hardcoded marathon prompt in `generateDailyBrief`**

Find this line in the `prompt` constant:

```typescript
const prompt = `You are a personal coach AND nutritionist for a marathon runner training for the Twin Cities Marathon on October 4, 2026. Use their training history and recovery trends to:
```

Replace with:

```typescript
const prompt = `You are a personal fitness and nutrition coach. Use the user's core profile (goals, activities, baselines) along with their training history and recovery trends to:
```

- [ ] **Step 4: Add HRV baseline drift check after brief generation**

At the end of `generateDailyBrief`, after `return parsed;`, add:

```typescript
  // Baseline drift: if 7-day HRV avg has shifted >3ms, update core-profile.md
  if (ctx.history?.avgHrv7d) {
    updateHrvBaseline(ctx.history.avgHrv7d);
  }

  return parsed;
```

Then add this function above `generateDailyBrief`:

```typescript
function updateHrvBaseline(currentAvg: number): void {
  const profile = readMemoryFile('core-profile.md');
  if (!profile) return;

  const match = /HRV baseline: (\d+)ms/.exec(profile);
  if (!match) return;

  const stored = parseInt(match[1], 10);
  if (Math.abs(currentAvg - stored) <= 3) return; // No significant drift

  const date = new Date().toISOString().split('T')[0];
  const updated = profile.replace(
    /HRV baseline: \d+ms \(updated [^)]+\)/,
    `HRV baseline: ${currentAvg}ms (updated ${date})`
  );
  writeMemoryFile('core-profile.md', updated);
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/simantstha/Documents/Playground/vital && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/claude.ts
git commit -m "feat: sport-agnostic brief prompt + HRV baseline auto-drift in core-profile"
```

---

## Task 5: End-to-end verification via Telegram

**Files:** none (manual testing only)

- [ ] **Step 1: Start dev server + localtunnel**

```bash
cd /Users/simantstha/Documents/Playground/vital && npm run dev
```

In a second terminal:

```bash
npx localtunnel --port 3000
```

Copy the tunnel URL.

- [ ] **Step 2: Re-register Telegram webhook**

```bash
curl "http://localhost:3000/api/telegram/setup?url=https://<tunnel-url>"
```

Expected response: `{"ok":true,...}`

- [ ] **Step 3: Test memory read — send a nutrition message**

Send to @VayamBot: `"what should I eat before a long run?"`

Expected: Coach responds with advice. Check dev server logs — you should see Claude making a `read_memory("nutrition-habits.json")` tool call before responding.

- [ ] **Step 4: Test explicit remember**

Send to @VayamBot: `"remember I'm allergic to shellfish"`

Expected: Coach confirms. Check `.vital-memory/health-conditions.json` — should contain:
```json
{ "allergies": [{ "substance": "shellfish", "severity": "unknown" }], ... }
```

- [ ] **Step 5: Test auto-extraction**

Send to @VayamBot: `"my left knee has been sore this week after my long run"`

Expected: Coach responds with advice. Check `.vital-memory/training-history.json` — should contain an entry in `injuries` for `left knee`.

- [ ] **Step 6: Test observation append**

Send to @VayamBot: `"I've been feeling really low energy every Wednesday"`

Expected: Check `.vital-memory/coach-observations.md` — should have a new dated entry about Wednesday low energy.

- [ ] **Step 7: Test "what do you know about me?"**

Send to @VayamBot: `"what do you know about me?"`

Expected: Coach reads all memory files and gives a coherent summary of goals, conditions, history, and recent observations.

- [ ] **Step 8: Final commit + push**

```bash
git add .vital-memory/
git commit -m "chore: update seeded vital-memory files after verification"
git push -u origin feat/vital-telegram-coach
```

---

## Self-Review

**Spec coverage check:**
- ✅ 7 memory files with correct structure — Task 2
- ✅ `memory-index.md` always loaded — Task 1 (`loadAlwaysOnContext`)
- ✅ `health-conditions.json` always loaded — Task 1 (`loadAlwaysOnContext`)
- ✅ `coach-observations.md` always loaded, rolling 30 — Task 1 (`appendObservation`)
- ✅ Domain files on-demand via `read_memory` tool — Task 3
- ✅ Auto-extraction via `write_memory` tool — Task 3 (Claude does this autonomously)
- ✅ Explicit remember/forget via Telegram — Task 3 (Claude handles the intent)
- ✅ HRV baseline drift — Task 4
- ✅ Sport-agnostic brief prompt — Task 4
- ✅ Migration from `user-profile.md` (fallback in Task 4 Step 2)

**Type consistency:**
- `MEMORY_TOOLS` defined in Task 1, imported in Task 3 ✅
- `handleToolCall` defined in Task 1, imported in Task 3 ✅
- `loadAlwaysOnContext` defined in Task 1, used in Task 3 ✅
- `readMemoryFile` / `writeMemoryFile` defined in Task 1, used in Task 4 ✅
- `updateHrvBaseline` defined and used within Task 4 ✅
