# Vital Coach — Long-Term Memory System Design

**Date:** 2026-05-13
**Status:** Approved

---

## Overview

Expand the Vital AI coach from a stateless daily brief generator into a persistent personal health intelligence that builds a rich, evolving picture of the user over time. The coach is a **generalized fitness and nutrition expert** — not sport-specific — that adapts its advice based on what it knows about the user.

---

## Goals

- Coach remembers facts across sessions: injuries, food reactions, PRs, allergies, life patterns
- Memory is safe-critical-aware: allergies and medical conditions always in context
- Context loading is smart: small always-loaded core + on-demand domain files via tool_use
- Memory is written two ways: Claude auto-extracts from conversations, user can explicitly remember/forget via Telegram
- Baselines (HRV, RHR, recovery%) adapt over time from real Whoop data rather than staying hardcoded

---

## Memory File Architecture

```
.vital-memory/
  memory-index.md           ← always loaded (~80 tokens) — manifest of all domain files
  core-profile.md           ← always loaded — identity, goals, activities, adaptive baselines
  coach-observations.md     ← always loaded — rolling last 30 dated coach notes
  health-conditions.json    ← always loaded (safety-critical) — allergies, conditions, medications
  training-history.json     ← on-demand — PRs, achievements, injuries, training notes
  nutrition-habits.json     ← on-demand — food preferences, GI triggers, supplements, patterns
  life-context.json         ← on-demand — stress events, travel, motivation patterns
```

### memory-index.md

Always loaded. Tells Claude what each file contains so it can decide what to fetch.

```markdown
- core-profile.md: identity, active goals, fitness activities, adaptive baselines (HRV/RHR/recovery)
- coach-observations.md: rolling dated coach notes from recent sessions
- health-conditions.json: allergies, medical conditions, medications, dietary restrictions (SAFETY)
- training-history.json: PRs, past race/event achievements, injury log, training notes
- nutrition-habits.json: food preferences, GI triggers, pre-workout meals, supplements, patterns
- life-context.json: stress events, travel log, motivation patterns
```

### core-profile.md (free-form markdown)

```markdown
# Vital — Core Profile

## Identity
- Age: [age]
- Sex: [male/female/other]
- Height: [height]
- Current weight: [weight] — last updated [date]

## Active Goals
- Primary: [e.g., Twin Cities Marathon, October 4 2026]
- Secondary: [e.g., reach 175lbs by August]

## Fitness Activities
- Primary: [e.g., running]
- Secondary: [e.g., gym/strength, cycling]

## Baselines — auto-updated by coach
- HRV baseline: 65ms (updated 2026-05-13)
- Resting HR: 49 bpm
- Recovery baseline: 72%
- Weight trend: [lbs/week change]
```

Baselines auto-drift: every time the daily brief runs, if the 30-day Whoop HRV average has shifted >2ms from the stored baseline, the coach calls `write_memory("core-profile.md", ...)` to update it.

### health-conditions.json (structured JSON)

Always loaded. Coach must never give advice that conflicts with these.

```json
{
  "allergies": [
    { "substance": "shellfish", "severity": "anaphylactic", "notes": "carries EpiPen" }
  ],
  "conditions": [
    { "name": "mild asthma", "notes": "inhaler before cold hard efforts >60min" }
  ],
  "medications": [
    { "name": "...", "timing": "morning", "relevance": "affects HR baseline" }
  ],
  "dietaryRestrictions": ["gluten-free"],
  "coachInstructions": [
    "Never suggest shellfish-containing foods",
    "Flag cold outdoor workouts >60min as potential asthma risk"
  ]
}
```

### training-history.json (structured JSON)

```json
{
  "PRs": {
    "5K": "22:10",
    "10K": null,
    "halfMarathon": "1:52:00",
    "marathon": null
  },
  "achievements": [
    {
      "date": "2025-10-05",
      "name": "Grandma's Half Marathon",
      "result": "1:52:00",
      "notes": "hot day, positive split"
    }
  ],
  "injuries": [
    {
      "date": "2026-03-15",
      "bodyPart": "left knee",
      "severity": "mild",
      "trigger": "increased mileage too fast",
      "resolved": false,
      "resolvedDate": null,
      "notes": "IT band related"
    }
  ],
  "trainingNotes": [
    {
      "date": "2026-05-01",
      "note": "Responded well to 18mi long run at easy pace, no fatigue next day"
    }
  ]
}
```

### nutrition-habits.json (structured JSON)

```json
{
  "preferences": [
    { "food": "oatmeal", "sentiment": "love", "notes": "go-to pre-run breakfast" },
    { "food": "beets", "sentiment": "dislike", "notes": "" }
  ],
  "GITriggers": [
    {
      "food": "dairy",
      "context": "pre-workout",
      "reaction": "cramping",
      "severity": "moderate"
    }
  ],
  "preWorkoutMeals": [
    {
      "meal": "oatmeal + banana",
      "timing": "2h before",
      "result": "good",
      "notes": "standard long run breakfast"
    }
  ],
  "supplements": [
    { "name": "creatine", "timing": "post-workout", "dose": "5g", "notes": "daily" }
  ],
  "patterns": [
    "Tends to undereat protein on rest days",
    "Craves carbs after long efforts >14mi"
  ]
}
```

### life-context.json (structured JSON)

```json
{
  "stressEvents": [
    {
      "date": "2026-04-15",
      "description": "exam week",
      "impact": "sleep + recovery dropped",
      "duration": "1 week"
    }
  ],
  "travelLog": [
    {
      "startDate": "2026-05-20",
      "endDate": "2026-05-25",
      "location": "NYC",
      "notes": "hotel gym only, no long run"
    }
  ],
  "motivationPatterns": [
    "Wednesday motivation slump is consistent",
    "Responds well to race-day visualization prompts"
  ],
  "generalNotes": []
}
```

### coach-observations.md (free-form markdown, rolling 30 entries)

```markdown
# Coach Observations

- [2026-05-13] HRV <55ms after back-to-back hard days — easy day restored it within 24h
- [2026-05-10] Work stress week correlated with poor sleep + sub-60% recovery
- [2026-05-08] Pre-run oatmeal + banana consistently results in good energy reports
```

Trimmed to last 30 entries. Oldest entries removed when new ones are appended.

---

## Context Loading — Tool Use Pattern

The coach receives three memory tools via the Claude tool_use API:

```typescript
tools: [
  {
    name: "read_memory",
    description: "Read a memory file by name. Use memory-index.md to decide what's relevant.",
    input_schema: { filename: string }
  },
  {
    name: "write_memory",
    description: "Overwrite a structured JSON memory file with updated content.",
    input_schema: { filename: string, content: string }
  },
  {
    name: "append_observation",
    description: "Append a dated coach observation to coach-observations.md.",
    input_schema: { note: string }
  }
]
```

**Every message flow:**

1. System prompt always contains: `core-profile.md` + `health-conditions.json` + `coach-observations.md` + `memory-index.md`
2. User sends a Telegram message
3. Claude reads the index, calls `read_memory("nutrition-habits.json")` if the message is about food/nutrition
4. We return file contents; Claude continues
5. Claude responds to the user
6. Claude optionally calls `write_memory(...)` to update a fact it just learned, or `append_observation(...)` for a coaching insight

The tool_use agentic loop is handled in `lib/telegramCoach.ts` — run until Claude stops calling tools, then send the final text to Telegram.

---

## Auto-Extraction Rules

What the coach silently extracts from every conversation turn:

| User mentions | Coach writes to |
|---|---|
| Sore body part / injury | `training-history.json` → injuries |
| Food causing stomach issues | `nutrition-habits.json` → GITriggers |
| Travel plans | `life-context.json` → travelLog |
| Race result or PR | `training-history.json` → PRs + achievements |
| Busy/stressful period | `life-context.json` → stressEvents |
| Supplement or medication | `nutrition-habits.json` → supplements or `health-conditions.json` → medications |
| Explicit "remember X" | Appropriate file based on topic |
| Explicit "forget X" | Patch appropriate file removing the entry |

Whoop-derived baseline drift (during brief generation):
- If 30-day HRV avg shifts >2ms from stored baseline → update `core-profile.md`

---

## Explicit Memory Commands (Telegram)

- `"remember I'm allergic to shellfish"` → Claude patches `health-conditions.json`
- `"remember I hate beets"` → Claude patches `nutrition-habits.json`
- `"forget the shellfish thing"` → Claude removes entry from `health-conditions.json`
- `"what do you know about me?"` → Claude calls `read_memory` on all files and summarizes

---

## Migration from Current State

Current `user-profile.md` gets split:
- Goals, baselines, typical days → `core-profile.md`
- Coach Notes section → `coach-observations.md` (seeded with existing notes)
- Dietary Preferences section → `nutrition-habits.json`

Current `weight-log.json` and `overrides.json` are unchanged.

---

## Files to Create / Modify

| File | Action |
|---|---|
| `lib/memory.ts` | New — read/write helpers for all memory files, tool definitions |
| `lib/telegramCoach.ts` | Modify — add tool_use loop, replace `readUserProfile()` with new context loader |
| `lib/claude.ts` | Modify — baseline drift check during brief generation |
| `.vital-memory/memory-index.md` | New |
| `.vital-memory/core-profile.md` | New (migrated from user-profile.md) |
| `.vital-memory/coach-observations.md` | New (migrated from Coach Notes) |
| `.vital-memory/health-conditions.json` | New |
| `.vital-memory/training-history.json` | New |
| `.vital-memory/nutrition-habits.json` | New |
| `.vital-memory/life-context.json` | New |

---

## Phase 1 Additions — Proactive & Richer Inputs

Three lightweight additions folded into Phase 1:

### A — Meal Photo → Macro Estimation

User sends a photo of their meal (not a barcode) → Claude estimates macros visually and logs as a meal override.

**How:** Extend `classifyImage` in `lib/telegramCoach.ts` to return `type: 'meal_photo'` with `{ description, kcal, c, p, f }`. Coach responds with the estimate and asks for confirmation before logging. Stores as a meal override in `coachState.ts` (same as barcode flow).

**No new memory file needed** — meal overrides already handled by `overrides.json`.

### B — Mood / Energy Check-in

User sends a message like "feeling exhausted today" or "energy 3/5" → coach extracts a score (1–5) and optional notes, stores in `life-context.json` under `moodLog`.

**`life-context.json` addition:**
```json
{
  "moodLog": [
    { "date": "2026-05-13", "score": 3, "notes": "felt tired after poor sleep" }
  ]
}
```

Coach detects mood-related language via the existing tool_use flow — no special routing needed. Claude writes to `life-context.json` using `write_memory` when it detects a mood signal. Over time correlates with HRV/recovery trends in coach observations.

### C — Whoop Webhook → Proactive Alerts

Expand `app/api/webhooks/whoop/route.ts` beyond the morning brief to send targeted proactive Telegram messages for three conditions:

| Condition | Trigger | Message |
|---|---|---|
| Red day | Recovery < 33% | "Recovery is in the red today — your body is asking for rest. Easy day recommended." |
| Green streak | 3+ consecutive days ≥ 67% recovery | "3 green days in a row — you're in a peak window. Good day for a hard effort if planned." |
| HRV crash | Current HRV < (baseline − 15%) | "HRV dropped significantly below your baseline — watch your load today." |

Baseline for HRV crash detection comes from `core-profile.md` (already maintained by the drift updater in Phase 1).

### D — Lab Results via Telegram

User sends a PDF or photo of a lab report → Claude extracts structured markers → stored in `.vital-memory/lab-results.json` → always loaded alongside health conditions (safety-relevant).

**`lab-results.json`:**
```json
{
  "lastUpdated": "2026-05-13",
  "results": [
    { "marker": "Ferritin", "value": 12, "unit": "ng/mL", "referenceRange": "12-300", "status": "low", "date": "2026-05-01" },
    { "marker": "Vitamin D", "value": 28, "unit": "ng/mL", "referenceRange": "30-100", "status": "low", "date": "2026-05-01" }
  ]
}
```

Added to `memory-index.md` and `loadAlwaysOnContext()`. Coach uses results to inform nutrition and supplement recommendations ("your ferritin is low — iron absorption is critical for your performance").

PDF handling: Telegram sends documents as `file_id` → download via Bot API → send to Claude as base64 using the existing `classifyImage` pattern.

---

## Phase 2 — Conversation History (Postgres)

Deferred. To be designed separately after Phase 1 ships.

**Core idea:** Store every Telegram message pair (user + assistant) in Postgres. On each new message, load last ~30 messages verbatim + an auto-generated weekly summary of older history. Coach gains true long-term conversational memory — can reference things said weeks ago, detect recurring patterns, and follow up on past commitments.

**Key components:**
- `conversations` table: `chat_id, role, content, timestamp`
- Weekly summary job: collapses older messages into a summary paragraph stored per week
- Context builder: loads recent messages + summaries into the `messages` array before each API call
- Unlocks: "you mentioned knee soreness 6 weeks ago — still recurring?", week-over-week pattern detection, accountability follow-ups

---

## Phase 3 — Proactive Intelligence

Deferred. To be designed separately.

- **Weekly Sunday summary** — cron job every Sunday, auto-generates a week-in-review Telegram message using Whoop + Strava + memory
- **Strava post-activity analysis** — Strava webhook → coach auto-analyzes splits, effort, recovery implications
- **Lab results deep analysis** — trend comparison across multiple lab reports over time

---

## Phase 4 — New Integrations

Deferred. Each requires a separate design.

- **Weather API** — real-time conditions inform workout and nutrition recommendations
- **Race predictor / injury risk scoring / periodization** — complex reasoning over training history
- **CGM (continuous glucose monitor)** — Libre/Dexcom data for real-time fueling strategy
- **Voice notes** — Whisper transcription of Telegram voice memos
- **Sleep debt tracker / goal drift alerts** — requires Postgres historical querying (Phase 2 prerequisite)
