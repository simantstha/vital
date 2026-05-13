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
| Create | `lib/nutritionix.ts` | Nutritionix Natural Language API — food lookup by description |
| Modify | `lib/telegramCoach.ts` | Tool_use agentic loop + new context loading + meal confirmation loop |
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

## Task 6: Meal Photo → Cal AI-Accuracy Macro Tracking

**Files:**
- Create: `lib/nutritionix.ts`
- Modify: `lib/telegramCoach.ts`
- Modify: `lib/coachState.ts` (add pending meal state)

Three-step flow: Claude vision identifies food items + portions → Nutritionix DB lookup for real macro data → Telegram confirmation loop where user corrects portions before logging.

Sign up for a free Nutritionix account at https://developer.nutritionix.com — free tier gives 500 calls/day. Add `NUTRITIONIX_APP_ID` and `NUTRITIONIX_APP_KEY` to `.env.local`.

- [ ] **Step 1: Create `lib/nutritionix.ts`**

```typescript
export interface NutritionixFood {
  food_name: string;
  serving_qty: number;
  serving_unit: string;
  nf_calories: number;
  nf_total_carbohydrate: number;
  nf_protein: number;
  nf_total_fat: number;
}

export interface NutritionixResult {
  kcal: number;
  c: number;
  p: number;
  f: number;
  foods: { name: string; qty: number; unit: string; kcal: number }[];
}

export async function lookupNutrition(query: string): Promise<NutritionixResult | null> {
  const res = await fetch('https://trackapi.nutritionix.com/v2/natural/nutrients', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-app-id': process.env.NUTRITIONIX_APP_ID!,
      'x-app-key': process.env.NUTRITIONIX_APP_KEY!,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) return null;

  const data = await res.json() as { foods: NutritionixFood[] };

  const totals = data.foods.reduce(
    (acc, f) => ({
      kcal: acc.kcal + Math.round(f.nf_calories),
      c: acc.c + Math.round(f.nf_total_carbohydrate),
      p: acc.p + Math.round(f.nf_protein),
      f: acc.f + Math.round(f.nf_total_fat),
    }),
    { kcal: 0, c: 0, p: 0, f: 0 }
  );

  return {
    ...totals,
    foods: data.foods.map(f => ({
      name: f.food_name,
      qty: f.serving_qty,
      unit: f.serving_unit,
      kcal: Math.round(f.nf_calories),
    })),
  };
}
```

- [ ] **Step 2: Add `PendingMeal` state to `lib/coachState.ts`**

Add after the existing `PendingBarcode` interface and functions:

```typescript
export interface PendingMeal {
  chatId: number;
  query: string;           // natural language string sent to Nutritionix
  result: {
    kcal: number; c: number; p: number; f: number;
    foods: { name: string; qty: number; unit: string; kcal: number }[];
  };
  meal: string;            // breakfast | lunch | snack | dinner
  expiresAt: number;       // epoch ms — 10-minute TTL
}

const PENDING_MEAL_FILE = path.join(MEMORY_DIR, 'pending-meal.json');

export function readPendingMeal(chatId: number): PendingMeal | null {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_MEAL_FILE, 'utf-8')) as PendingMeal;
    if (p.chatId !== chatId || Date.now() > p.expiresAt) return null;
    return p;
  } catch { return null; }
}

export function writePendingMeal(pending: PendingMeal) {
  ensureDir();
  try { fs.writeFileSync(PENDING_MEAL_FILE, JSON.stringify(pending), 'utf-8'); } catch { /* ok */ }
}

export function clearPendingMeal() {
  try { fs.unlinkSync(PENDING_MEAL_FILE); } catch { /* ok */ }
}
```

- [ ] **Step 3: Extend `classifyImage` in `lib/telegramCoach.ts` to identify food items + portions**

Replace the existing `classifyImage` function:

```typescript
async function classifyImage(base64: string, mimeType: string): Promise<
  | { type: 'barcode'; value: string }
  | { type: 'meal_photo'; query: string; items: string[] }
  | { type: 'other' }
> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType as 'image/jpeg', data: base64 } },
        {
          type: 'text',
          text: `Classify this image. Respond with JSON only, no markdown.

If it shows a barcode or QR code: {"type":"barcode","value":"<digits>"}
If it shows food or a meal: {"type":"meal_photo","query":"<natural language list for Nutritionix, e.g. '6oz grilled chicken breast, 1 cup brown rice, 1 cup steamed broccoli'>","items":["<item 1>","<item 2>"]}
Otherwise: {"type":"other"}

For meal_photo: estimate realistic portion sizes for each visible item. query must be a single comma-separated string of items with quantities and cooking method.`,
        },
      ],
    }],
  });
  const content = (msg.content[0] as { text: string }).text;
  return JSON.parse(content.replace(/```json\n?|```/g, '').trim());
}
```

- [ ] **Step 4: Add meal photo + confirmation loop handling to `processMessage` in `lib/telegramCoach.ts`**

Add imports at the top:

```typescript
import { lookupNutrition } from '@/lib/nutritionix';
import { readPendingMeal, writePendingMeal, clearPendingMeal, type PendingMeal } from '@/lib/coachState';
```

In `processMessage`, add pending meal check **before** the image block (so text replies to a pending meal are caught first):

```typescript
// Check if user is confirming or correcting a pending meal estimate
const pendingMeal = readPendingMeal(chatId);
if (pendingMeal && !image) {
  const text = update.message?.text?.toLowerCase() ?? '';
  const isConfirm = /^(yes|yeah|yep|correct|log|ok|looks good|right)/i.test(text);

  if (isConfirm) {
    clearPendingMeal();
    writeMealOverride({
      meal: pendingMeal.meal,
      kcal: pendingMeal.result.kcal,
      c: pendingMeal.result.c,
      p: pendingMeal.result.p,
      f: pendingMeal.result.f,
      items: pendingMeal.query,
      reason: 'meal photo + Nutritionix',
      updatedAt: new Date().toISOString(),
    });
    await sendTelegram(chatId, `✅ Logged: ${pendingMeal.result.kcal}kcal · ${pendingMeal.result.p}g protein · ${pendingMeal.result.c}g carbs · ${pendingMeal.result.f}g fat`);
    return;
  } else {
    // User is correcting portions — treat their text as a new Nutritionix query
    clearPendingMeal();
    const corrected = await lookupNutrition(update.message?.text ?? '');
    if (corrected) {
      const hour = new Date().getHours();
      const meal = hour < 10 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';
      const newPending: PendingMeal = {
        chatId,
        query: update.message?.text ?? '',
        result: corrected,
        meal,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      writePendingMeal(newPending);
      const itemLines = corrected.foods.map(f => `  • ${f.qty} ${f.unit} ${f.name} — ${f.kcal}kcal`).join('\n');
      await sendTelegram(chatId, `Updated estimate:\n${itemLines}\n\nTotal: ${corrected.kcal}kcal · ${corrected.p}g protein · ${corrected.c}g carbs · ${corrected.f}g fat\n\nLooks right? (yes / correct it)`);
      return;
    }
  }
}
```

Then in the image block, add the meal photo case after the barcode case:

```typescript
} else if (classification.type === 'meal_photo') {
  const nutrition = await lookupNutrition(classification.query);
  if (!nutrition) {
    await sendTelegram(chatId, "I could see the food but couldn't look up the nutrition data. Try describing what you ate in text.");
    return;
  }
  const hour = new Date().getHours();
  const meal = hour < 10 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';
  const pending: PendingMeal = {
    chatId,
    query: classification.query,
    result: nutrition,
    meal,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  writePendingMeal(pending);
  const itemLines = nutrition.foods.map(f => `  • ${f.qty} ${f.unit} ${f.name} — ${f.kcal}kcal`).join('\n');
  await sendTelegram(chatId, `I see:\n${itemLines}\n\nTotal: ${nutrition.kcal}kcal · ${nutrition.p}g protein · ${nutrition.c}g carbs · ${nutrition.f}g fat\n\nLooks right? Reply *yes* to log it, or correct the portions.`);
  return;
```

- [ ] **Step 5: Add env vars to `.env.local`**

```
NUTRITIONIX_APP_ID=your_app_id_here
NUTRITIONIX_APP_KEY=your_app_key_here
```

Get these from https://developer.nutritionix.com (free account, 500 calls/day).

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /Users/simantstha/Documents/Playground/vital && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Test the full flow**

Send a meal photo to @VayamBot. Expected sequence:
1. Bot replies: "I see: • 6oz grilled chicken — 280kcal, • 1 cup brown rice — 216kcal..." with confirmation prompt
2. Reply "the chicken was more like 8oz" → bot recalculates and asks again
3. Reply "yes" → bot confirms logged + shows totals
4. Check `.vital-memory/overrides.json` — entry for the correct meal slot with Nutritionix macros

- [ ] **Step 8: Commit**

```bash
git add lib/nutritionix.ts lib/coachState.ts lib/telegramCoach.ts
git commit -m "feat: Cal AI-accuracy meal photo tracking — vision + Nutritionix + confirmation loop"
```

---

## Task 7: Mood / Energy Check-in

**Files:**
- Modify: `.vital-memory/life-context.json` (schema addition only — actual writes happen via Claude tool_use)
- Modify: `lib/memory.ts` (update `MEMORY_TOOLS` write description to mention mood)

The mood log is written automatically by Claude when it detects mood/energy signals in any message. No special routing code needed — it uses the existing `write_memory` tool.

- [ ] **Step 1: Update `life-context.json` seed to include `moodLog`**

Update `.vital-memory/life-context.json` to:

```json
{
  "stressEvents": [],
  "travelLog": [],
  "motivationPatterns": [],
  "moodLog": [],
  "generalNotes": []
}
```

- [ ] **Step 2: Update `write_memory` tool description in `lib/memory.ts` to mention mood**

Find the `write_memory` tool description and extend it:

```typescript
description:
  'Overwrite a structured JSON memory file with updated content. Use when you learn a new fact (injury, food reaction, PR, allergy, supplement, stress event, travel, mood/energy score). Always read the file first, merge the new fact, then write the full updated JSON. For mood: add to life-context.json moodLog as { date, score (1-5), notes }.',
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/simantstha/Documents/Playground/vital && npx tsc --noEmit
```

- [ ] **Step 4: Test — send a mood message to @VayamBot**

Send: `"feeling really tired today, energy is maybe a 2/5"`

Expected: Coach acknowledges and offers advice. Check `.vital-memory/life-context.json` — `moodLog` should contain a new entry with today's date, score 2, and notes.

- [ ] **Step 5: Commit**

```bash
git add .vital-memory/life-context.json lib/memory.ts
git commit -m "feat: mood/energy check-in stored in life-context moodLog"
```

---

## Task 8: Whoop Webhook → Proactive Alerts

**Files:**
- Modify: `app/api/webhooks/whoop/route.ts`
- Modify: `lib/memory.ts` (add `readHrvBaseline` helper)

Expand the webhook beyond the morning brief to detect three conditions and send targeted Telegram messages.

- [ ] **Step 1: Add `readHrvBaseline` to `lib/memory.ts`**

```typescript
export function readHrvBaseline(): number | null {
  const profile = readMemoryFile('core-profile.md');
  if (!profile) return null;
  const match = /HRV baseline: (\d+)ms/.exec(profile);
  return match ? parseInt(match[1], 10) : null;
}
```

- [ ] **Step 2: Add `checkProactiveAlerts` function to `app/api/webhooks/whoop/route.ts`**

Add this import at the top:

```typescript
import { readHrvBaseline } from '@/lib/memory';
```

Add this function:

```typescript
async function checkProactiveAlerts(recovery: number, hrv: number, chatId: number): Promise<void> {
  const messages: string[] = [];

  // Red day
  if (recovery < 33) {
    messages.push(`🔴 Recovery is ${recovery}% today — your body is asking for rest. Easy day or full rest recommended.`);
  }

  // HRV crash (>15% below baseline)
  const baseline = readHrvBaseline();
  if (baseline && hrv < baseline * 0.85) {
    messages.push(`⚠️ HRV dropped to ${hrv}ms — significantly below your ${baseline}ms baseline. Watch your load today.`);
  }

  for (const msg of messages) {
    await sendTelegram(chatId, msg);
  }
}
```

- [ ] **Step 3: Add green streak detection to `app/api/webhooks/whoop/route.ts`**

Green streak requires knowing the last 3 recovery scores. Add a lightweight streak tracker using the existing `.vital-memory/` directory:

```typescript
import fs from 'fs';
import path from 'path';

const STREAK_FILE = path.resolve(process.cwd(), '.vital-memory/recovery-streak.json');

function updateRecoveryStreak(recovery: number): number {
  let streak: { date: string; recovery: number }[] = [];
  try { streak = JSON.parse(fs.readFileSync(STREAK_FILE, 'utf-8')); } catch { /* ok */ }

  const today = new Date().toISOString().split('T')[0];
  streak = streak.filter(s => s.date !== today);
  streak.push({ date: today, recovery });
  streak.sort((a, b) => b.date.localeCompare(a.date));
  streak = streak.slice(0, 7); // keep last 7 days

  try { fs.writeFileSync(STREAK_FILE, JSON.stringify(streak), 'utf-8'); } catch { /* ok */ }

  // Count consecutive green days
  let count = 0;
  for (const s of streak) {
    if (s.recovery >= 67) count++;
    else break;
  }
  return count;
}
```

- [ ] **Step 4: Wire alerts into the existing webhook handler**

In the existing webhook handler, after the brief is sent, add:

```typescript
// After sending the brief:
const greenStreak = updateRecoveryStreak(recoveryScore);
if (greenStreak >= 3 && greenStreak === Math.floor(greenStreak)) {
  await sendTelegram(chatId, `💚 ${greenStreak} green days in a row — you're in a peak window. Good day for a hard effort if it's on your plan.`);
}
await checkProactiveAlerts(recoveryScore, hrvMs, chatId);
```

Note: you'll need to extract `recoveryScore`, `hrvMs`, and `chatId` from the existing webhook payload. Check `app/api/webhooks/whoop/route.ts` for the exact field names from the Whoop payload.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/simantstha/Documents/Playground/vital && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/whoop/route.ts lib/memory.ts
git commit -m "feat: proactive Whoop alerts — red day, HRV crash, green streak"
```

---

## Task 9: Lab Results via Telegram

**Files:**
- Create: `.vital-memory/lab-results.json`
- Modify: `lib/memory.ts` (add `lab-results.json` to allowed files + `loadAlwaysOnContext`)
- Modify: `lib/telegramCoach.ts` (handle PDF documents + lab report detection)

- [ ] **Step 1: Create `.vital-memory/lab-results.json`**

```json
{
  "lastUpdated": null,
  "results": []
}
```

- [ ] **Step 2: Add `lab-results.json` to `ALLOWED_FILES` in `lib/memory.ts`**

```typescript
const ALLOWED_FILES = [
  'memory-index.md',
  'core-profile.md',
  'coach-observations.md',
  'health-conditions.json',
  'training-history.json',
  'nutrition-habits.json',
  'life-context.json',
  'lab-results.json',   // ← add this
] as const;
```

Also add it to the `write_memory` tool's `enum`:

```typescript
enum: ['health-conditions.json', 'training-history.json', 'nutrition-habits.json', 'life-context.json', 'core-profile.md', 'lab-results.json'],
```

- [ ] **Step 3: Add lab results to `loadAlwaysOnContext` in `lib/memory.ts`**

```typescript
export function loadAlwaysOnContext(): string {
  const index = readMemoryFile('memory-index.md') ?? '';
  const core = readMemoryFile('core-profile.md') ?? '';
  const conditions = readMemoryFile('health-conditions.json') ?? '{}';
  const observations = readMemoryFile('coach-observations.md') ?? '';
  const labs = readMemoryFile('lab-results.json') ?? '{}';

  return [
    '## Memory Index\n' + index,
    '## Core Profile\n' + core,
    '## Health Conditions (SAFETY — always follow these)\n```json\n' + conditions + '\n```',
    '## Lab Results\n```json\n' + labs + '\n```',
    observations,
  ].join('\n\n---\n\n');
}
```

- [ ] **Step 4: Update `memory-index.md` to include lab results**

Add this line to `.vital-memory/memory-index.md`:

```
- lab-results.json: blood lab results — markers, values, reference ranges, status (always loaded)
```

- [ ] **Step 5: Add PDF document handling to `processMessage` in `lib/telegramCoach.ts`**

The Telegram webhook sends documents differently from photos. In `processMessage`, add PDF detection before the existing image block:

```typescript
// Handle PDF documents (lab reports)
const document = update.message?.document;
if (document && document.mime_type === 'application/pdf') {
  const fileUrl = await getTelegramFileUrl(document.file_id);
  const res = await fetch(fileUrl);
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  userContent = `[User sent a PDF document — likely a lab report. Analyze it, extract all lab markers as structured data, and call write_memory("lab-results.json") with the results. Then summarize the key findings in plain language, highlighting anything outside the normal range.]`;
  // Attach the PDF to the user message
  userContent = [{
    type: 'text' as const,
    text: userContent,
  }, {
    type: 'document' as const,
    source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 },
  }];
}
```

Add `getTelegramFileUrl` helper:

```typescript
async function getTelegramFileUrl(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const json = await res.json() as { result: { file_path: string } };
  return `https://api.telegram.org/file/bot${token}/${json.result.file_path}`;
}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /Users/simantstha/Documents/Playground/vital && npx tsc --noEmit
```

- [ ] **Step 7: Test — send a lab report PDF to @VayamBot**

Send a PDF lab report. Expected: Coach extracts markers and summarizes findings. Check `.vital-memory/lab-results.json` — should contain structured results with values and status flags.

- [ ] **Step 8: Commit**

```bash
git add .vital-memory/lab-results.json lib/memory.ts lib/telegramCoach.ts
git commit -m "feat: lab results via Telegram PDF — extracted, stored, always in coach context"
```

---

## Self-Review

**Spec coverage check:**
- ✅ 7 core memory files — Task 2
- ✅ `memory-index.md` always loaded — Task 1
- ✅ `health-conditions.json` always loaded — Task 1
- ✅ `lab-results.json` always loaded — Task 9
- ✅ `coach-observations.md` rolling 30 — Task 1
- ✅ Domain files on-demand via `read_memory` — Task 3
- ✅ Auto-extraction via `write_memory` — Task 3
- ✅ Explicit remember/forget — Task 3
- ✅ HRV baseline drift — Task 4
- ✅ Sport-agnostic brief prompt — Task 4
- ✅ Meal photo macro estimation — Task 6
- ✅ Mood/energy check-in → `moodLog` — Task 7
- ✅ Proactive alerts (red day, HRV crash, green streak) — Task 8
- ✅ Lab results via PDF — Task 9

**Type consistency:**
- `MEMORY_TOOLS` / `handleToolCall` / `loadAlwaysOnContext` defined Task 1, used Tasks 3, 4, 9 ✅
- `readHrvBaseline` defined Task 8 Step 1, used Task 8 Step 2 ✅
- `updateRecoveryStreak` defined and used within Task 8 ✅
- `getTelegramFileUrl` defined and used within Task 9 ✅
- `writeMealOverride` imported from `coachState` (already exists), used Task 6 ✅
- `MEMORY_TOOLS` defined in Task 1, imported in Task 3 ✅
- `handleToolCall` defined in Task 1, imported in Task 3 ✅
- `loadAlwaysOnContext` defined in Task 1, used in Task 3 ✅
- `readMemoryFile` / `writeMemoryFile` defined in Task 1, used in Task 4 ✅
- `updateHrvBaseline` defined and used within Task 4 ✅
