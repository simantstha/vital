# Vital — Architecture & Product Spec v0.1

**Status:** Draft for co-founder review
**Date:** 2026-05-16
**Authors:** Simant + Claude (brainstorm), with prior input from Gemini
**Goal of this doc:** Capture the product vision, the v1 scope, and the architecture decisions made so far — with rationale for the cuts — so that two people can build from the same blueprint.

---

## 1. Product Vision

**Vital is an always-on personal nutrition and coaching AI that knows you the way a real coach who's worked with you for years would.**

The product moves beyond passive data tracking. It learns the user's biometrics, lifestyle, constraints, and patterns — and gets smarter as the user interacts with it. The longer a user engages, the more context the AI has, the better the coaching becomes. This compounding context is the moat.

**Positioning:** *Proactive observation, not prescription.* The AI frames insights as hypotheses ("Your energy is low and HRV is dropping — could be worth checking iron levels") rather than diagnoses. This is intentional, both for safety and to stay out of the medical-device regulatory trap.

**Why now**
- HealthKit ecosystem is mature — most wearables write to it (Whoop, Oura, Apple Watch, Garmin via third-party apps).
- LLMs are cheap and smart enough to handle conversational coaching at consumer price points.
- Vision models can estimate macros from a meal photo with reasonable accuracy.
- The existing market (MyFitnessPal, Whoop, Strava, Noom) is fragmented and dumb — none of them connect the dots across data sources or remember anything about you beyond surface-level metrics.

**Who it's for**
- People serious about their health who want real coaching without the $200/month price tag.
- Initial wedge: athletes/fitness-focused users with HealthKit-connected wearables.
- Eventually: anyone willing to share enough health data to benefit from a personalized coach.

---

## 2. Day in the Life

A normal day with Vital, from the user's side. This is what we're building toward.

**7:00 am — Morning check-in (push notification)**
> *"Morning. HRV 71ms, slept 7h 40m — your peak window. Big day today or chill?"*
> User: *"long run, 10mi"*
> Vital: *"Good. Pre-run: oats + banana + spoon of peanut butter (~450 cal, 12g protein). I'll watch your heart rate. Lunch budget after the run is ~900 cal, lean protein."*

**12:30 pm — Lunch logging (photo)**
> User snaps a photo of a chicken bowl.
> Vital: *"Looks like ~620 cal, 45g protein, 60g carbs. Confirm?"*
> User: *"yep"*
> Vital: *"Dinner has ~1,200 cal left. You'll want carbs — 80g+ — for glycogen refill."*

**5:00 pm — Proactive nudge**
> Vital notices user has logged only 4k steps for two days in a row.
> *"Two low-movement days back to back — anything off? Tired, sick, busy? Want to think it through?"*

**8:00 pm — Lab upload**
> User uploads a PDF blood panel.
> Vital: *"Read it. Ferritin's 28 ng/mL — bottom of the normal range. Combined with your low-step days and the fatigue you mentioned last week, this is worth flagging. Want to talk options?"*

**Always running in the background**
- HealthKit syncs HRV, sleep, workouts, heart rate, steps as they're recorded.
- Vital's ontology grows: every confirmed allergy, medication, family history mention, lab marker, pantry item, food preference becomes a structured fact it remembers forever.

**The magic moment** (the demo that sells the product)
A user gets a reply that demonstrably uses (a) their real biometric data from today, (b) a hard constraint they mentioned weeks ago, and (c) understanding of what they just said — in one coherent, useful message.

---

## 3. v1 Feature Scope

What ships in the first release. Everything below must work end-to-end.

- [ ] **iOS app** (SwiftUI) — chat-primary interface (final UI shape TBD; see Open Questions)
- [ ] **HealthKit ingestion** — iOS reads on app open + background refresh, posts deltas to backend
- [ ] **Onboarding flow** — name, age, sex, height, weight, allergies, intolerances, medications, conditions, family history (optional), goal (weight loss / muscle / endurance / general health), dietary restrictions, cuisine preferences
- [ ] **Dynamic macro calculator** — deterministic tool. Inputs: goal, current weight, today's logged workouts. Output: macro targets for the rest of the day. Recalculates intraday.
- [ ] **Hard constraint enforcement** — allergies, intolerances, conditions, meds, injuries are always loaded into system prompt. Coach never violates them.
- [ ] **Photo-to-macro meal logging** — vision call estimates macros + portion sizes, user confirms via chat, becomes a logged event.
- [ ] **Pantry / grocery list upload** — user uploads grocery photo or text list, vision/text parse → pantry inventory. Meals consume from pantry.
- [ ] **Three-tier meal recommendation** — when user asks "what should I eat?", suggestions filter through: (1) safety + macro fit, (2) pantry availability, (3) flavor preferences.
- [ ] **Proactive nudges** — daily cron runs simple heuristics (step drop, HRV trend, missed workouts) → push notification + chat-initiated message.
- [ ] **Lab PDF interpretation** — user uploads PDF, Claude extracts markers + reference ranges, stores as events + ontology nodes. Coach can reference them in future conversations.
- [ ] **Living ontology** — structured map of everything Vital knows about the user. Grows from explicit signals (onboarding, uploads, user confirmations, coach-initiated `remember_fact` tool calls). Marinates over time.
- [ ] **Coach personality** — always-on, friendly, observation-not-prescription tone, proactive when it has signal.

**Out of scope for v1** (deferred to v2+, see §8)
- Background extraction of facts from free-text chat (the auto-marinating pipeline)
- Pattern mining (weekly Claude job that finds correlations)
- Semantic memory / vector recall of past conversations
- Cohort intelligence
- Multi-user / sharing / social features
- Android, web

---

## 4. Architecture Decisions

These are the load-bearing stances. Each is paired with the alternative we rejected and why.

### 4.1 Single Postgres database, not three

**Decision:** All data lives in Postgres. Use pgvector extension for embeddings when needed (deferred to v2). No Neo4j, no separate vector DB.

**Rejected:** The hybrid Postgres + Neo4j + pgvector design originally proposed with Gemini.

**Why:**
- Operational cost of multiple databases is real: two backup strategies, two migration tools, two monitoring stacks, two connection pools, plus sync logic between them.
- At our scale (single user → tens of thousands), Postgres handles graph-shaped queries on a `nodes`/`edges` schema in microseconds. Neo4j wins for *millions of nodes with 5+ hop traversals*, which isn't us.
- We keep transactional consistency: an event write and the ontology updates it triggers can live in the same transaction.
- If we ever genuinely need Cypher graph syntax, [Apache AGE](https://age.apache.org/) gives openCypher on Postgres without a second DB.

**When this decision could flip:** If we hit a query pattern that requires variable-depth graph traversal that's painful in SQL. We haven't found one.

---

### 4.2 Event-sourced architecture

**Decision:** All raw data lands in an append-only `events` table. Everything else — current state, ontology, summaries — is *derived* from events. Events are never mutated, never deleted.

**Why:**
- We can rebuild the entire system state from the event stream alone. Bugs in derived layers are recoverable.
- Time travel: "what did Vital know about the user on 2026-04-12?" is a query, not a wish.
- Auditability: every coach decision can be traced to the events that informed it.

**Trade-off:** Slightly more storage and more careful schema design upfront. Worth it.

---

### 4.3 Deterministic Orchestrator, not agentic RAG

**Decision:** Code decides what context to load into the LLM. The LLM is given a *prepared* prompt with structured numbers, constraints, and ontology facts. It does not roam the database.

**Rejected:** Letting Claude call free-form retrieval tools to decide what context it needs.

**Why:**
- Predictable. Auditable. We can log every prompt and see exactly what was included and why.
- Numbers must come from SQL, not from LLM judgment. "HRV = 71ms" is a row, not a sentence Claude paraphrased.
- Lower latency: no multi-turn agent loop before the first useful reply.

**Trade-off:** Less flexible than agentic. We accept this for v1; can layer agentic tool-calling on top later for edge cases.

---

### 4.4 Numbers from SQL, narrative from vectors

**Decision:** Two retrieval paths, used for different things, never confused.

- Numeric / structured: direct SQL queries against events and current-state tables.
- Free-text / semantic: pgvector similarity search (v2).

**Why:** Vector recall is for *meaning*. It's the wrong tool for "what's my current weight?" — using it there is how you get hallucinated metrics.

---

### 4.5 Math is tools, not vibes

**Decision:** All calculations (TDEE, macros, baselines, trend deltas) are deterministic functions that Claude *calls* via tool use. Claude never does arithmetic from numbers in context.

**Why:** LLMs hallucinate numbers. Especially in long contexts with multiple metrics. Tool calls return ground-truth answers.

**Example tools:** `calculate_macros(goal, weight, today_workouts)`, `compute_hrv_baseline(days)`, `pantry_check(ingredients)`.

---

### 4.6 Hard constraints injected always; validator deferred

**Decision (v1):** Hard constraints (allergies, meds, conditions, injuries) are loaded into the system prompt on every coach call. Trust prompt engineering for safety in v1.

**Deferred (v2 or earlier if triggered):** Post-response deterministic validator that checks the reply against the constraint set before showing it to the user. If violated, regenerate.

**Trigger to add the validator early:** The first time Claude suggests something that violates a constraint.

---

### 4.7 Living ontology, grown from explicit signals only (v1)

**Decision:** The ontology (nodes + edges in Postgres) grows from *explicit* signals only in v1:
- Onboarding answers
- Lab PDF uploads (extracted markers)
- Grocery photo / list uploads (pantry items)
- Meal logging (consumption edges)
- User confirmations in chat ("yes, add that as allergy")
- Claude's `remember_fact` tool call (coach explicitly decides to save something)

**Deferred to v2:** Background extraction pipeline that re-reads every chat conversation looking for facts to extract (salience gate → structured extraction → canonicalization → promotion gates → pending proposals).

**Why defer:**
- The extraction pipeline is the single most complex piece of the entire architecture and the riskiest (silent data corruption if prompts are off).
- The ontology still grows and marinates from explicit signals — every confirmed fact, every upload, every lab result, every meal logged.
- Once the rest of the system is real, we'll know empirically what the extraction pipeline needs to catch — instead of designing it speculatively.

**Trigger to add it back:** When manual `remember_fact` tool calls feel insufficient — i.e., the coach is consistently missing facts the user mentioned in passing.

---

### 4.8 Pattern mining, cohort engine deferred

**Decision (v1):** No weekly pattern-mining cron, no cohort engine.

**Why:**
- Pattern mining needs 3+ months of one user's data to find anything reliable.
- Cohort intelligence needs 50+ users to be a moat. At User 1, it's just generic LLM advice with a "cohort" wrapper.
- Both are *additive* — they can be built on top of the event stream + ontology without rewriting anything.

**Trigger to add:** Pattern mining when one user has 3+ months of data. Cohort when we have 50+ paying users.

---

### 4.9 Cloud-first hosting, iOS pushes deltas

**Decision:**
- Backend hosted in the cloud (Vercel + Neon or equivalent — see Open Questions).
- iOS app reads HealthKit on open + via background refresh, pushes deltas to backend.
- Backend never polls HealthKit directly (it can't — HealthKit is on-device only).

**Why:** Simpler than on-device LLM inference. Easier to ship updates. Cohort engine works. Battery-friendly on iOS.

**Health data concern:** Will need to choose a HIPAA-compliant Postgres provider once we have paying users. Out of scope for v0.1 (single user / friends).

---

## 5. Data Model

High-level shape. Field-level schema comes later when we're actually coding.

### Five tables

```
events
├── id, user_id, timestamp, type, payload (JSONB), source
└── Indexes: (user_id, timestamp), (user_id, type, timestamp)
   
   Event types:
     hrv_reading, sleep_session, workout_completed, steps_recorded,
     meal_logged, weight_logged, mood_reported, lab_result,
     medication_taken, message_sent, message_received

nodes
├── id, user_id, type, label, properties (JSONB), source, created_at, weight
└── Indexes: (user_id, type), (user_id, label)
   
   Node types (closed schema for v1):
     Person, Condition, Medication, Allergy, Intolerance,
     Goal, Habit, FoodPreference, Cuisine, PantryItem,
     LabMarker, Injury, FamilyHistory

edges
├── id, user_id, from_node, to_node, predicate, properties (JSONB), 
│   weight, source, created_at, last_reinforced_at
└── Indexes: (user_id, from_node, predicate), (user_id, to_node, predicate)
   
   Predicates (closed schema for v1):
     has_condition, has_allergy, has_intolerance, takes_medication,
     has_family_member, has_goal, has_habit, prefers,
     contains_ingredient, blocks_activity, last_value

messages
├── id, user_id, timestamp, role (user|assistant), content, 
│   tool_calls (JSONB), images (JSONB)
└── Indexes: (user_id, timestamp)

pending_nudges
├── id, user_id, type, payload, scheduled_for, sent_at
└── Indexes: (user_id, scheduled_for)
```

### Where new nodes come from in v1

| Source | Produces |
|---|---|
| Onboarding form | Person (User), Goal, Allergy/Intolerance/Condition/Medication, FamilyHistory, FoodPreference |
| Lab PDF upload | LabMarker nodes + value events |
| Grocery upload | PantryItem nodes |
| Meal logged | (event only; pantry decrement edges) |
| Chat: user confirms | Whatever the coach asked about |
| Coach `remember_fact` | New node + edge proposed by Claude inside a conversation |

### Edge weight + reinforcement (simple v1 version)

- Every edge has `weight: float (0-1)` and `last_reinforced_at: timestamp`.
- New edge from confirmed source → `weight: 0.9`.
- New edge from `remember_fact` tool call → `weight: 0.6`.
- Each time an edge is reinforced (same fact mentioned again, with `weight + 0.1`, cap at 1.0).
- Weekly cron decays low-weight edges that haven't been reinforced (`weight × 0.95`).
- Hard constraints (allergies, meds, conditions) never decay.

---

## 6. The Coach Loop

What happens when the user sends a message.

```
1. iOS posts message to /coach with optional image attachment.
2. Backend assembles context (deterministic):
   a. User profile (top ~50 ontology nodes, hard constraints first)
   b. Current state (today's macros, recent workouts, current pantry)
   c. Last 7 days of events (compact summary)
   d. Last 20 messages of chat
   e. The new user message
3. Backend calls Claude (Sonnet 4.6 or 4.7) with:
   - System prompt (Vital coach persona + hard constraints + tool definitions)
   - Assembled context as user message
   - Tools available:
       * calculate_macros(goal, weight, today_workouts)
       * compute_hrv_baseline(days)
       * pantry_check(ingredients)
       * remember_fact(node_type, label, evidence, links_to)
       * confirm_with_user(question)
       * query_ontology(predicate, type)
       * query_events(type, range)
       * log_meal(image_or_text, claimed_calories)
4. Claude may make tool calls (multi-turn loop server-side, transparent to user).
5. Final reply streams back to iOS via Server-Sent Events.
6. Reply stored as `message_received` event + message row.
7. Any `remember_fact` tool calls write to ontology.
8. Any `log_meal` writes to events + pantry decrement.
```

### Estimated context budget per call

| Section | Tokens |
|---|---|
| System prompt + persona | ~400 |
| Hard constraints (allergies, meds, conditions) | ~200 |
| Top ontology nodes/edges | ~800 |
| Current state | ~300 |
| Last 7 days events (compact) | ~800 |
| Last 20 messages | ~1,500 |
| New user message | ~50–500 |
| **Total input** | **~4,000–4,500** |

Manageable. Well within Claude's context window. Predictable cost per turn.

---

## 7. Open Questions (for friend review + future decisions)

Things we haven't resolved yet. These are the *real* questions for the upcoming co-founder sync.

### Product
1. **iOS UI shape.** Chat-first (one screen, everything in messages), dashboard + chat tab, or smart dashboard with AI woven in? We tabled this — needs a call.
2. **Proactive nudge frequency.** How aggressive? Every red flag, or only when 2+ correlated signals? Tuning question; default to conservative for v1.
3. **Onboarding length.** How many screens before user can use the chat? More upfront = better day-1 coaching. Less upfront = lower drop-off. Sweet spot?
4. **Photo-to-macro confirmation UX.** Modal confirmation, inline in chat, or automatic with thumbs-up/down?

### Technical
5. **Hosting specifics.** Vercel + Neon? Fly.io + Supabase? Cloudflare + something? Friends, costs, latency in your region.
6. **Auth.** Sign in with Apple (iOS native, free, frictionless)? Email/password? Both?
7. **Push notification infrastructure.** APNs directly, OneSignal, Pusher Beams? Affects nudge job design.
8. **Vision model for photos.** Claude with vision is convenient. GPT-4 Vision is slightly better on food. Test both? Pick by accuracy?
9. **Privacy / HIPAA stance.** When (if?) do we go HIPAA-compliant? Only when we charge customers? Only when we hit N users?
10. **Storage of raw HealthKit data.** All of it, or only what we care about (HRV, sleep, workouts, heart rate, steps, weight)? Storage cost vs future-proofing.
11. **Pantry photo accuracy.** Realistic expectation. Will it really parse a fridge photo well? Or do we lean on text/typed input + barcode scan as fallbacks?

### Team / process
12. **Who builds what.** Friend on backend + you on iOS? Split by feature? Both full-stack and alternate?
13. **Stack choice for backend.** Continue with Next.js (already in this repo)? Switch to Hono / FastAPI / Go? Whatever the friend prefers?
14. **Source of truth for product decisions.** Where do we write things down? GitHub issues? Linear? This doc + a Notion?
15. **Sync cadence.** Daily standup async? Weekly call? Ad hoc?
16. **What's our north-star demo.** What does the "this works" moment look like for v1? Recording for ourselves? Showing to 3 friends? Putting it on TestFlight?

---

## 8. v2 / v3 Roadmap

Everything we cut from v1, in rough order of when to add it back. None of these requires a rewrite — they all layer on top of the v1 architecture.

### v2 (add after v1 ships and has been used for ~1 month)
- **Background chat extraction pipeline** (the auto-marinating system from §4.7) — salience gate → structured extraction → canonicalization → promotion gates
- **pgvector for semantic recall** — when chat history overflows context, retrieve relevant past conversations
- **Post-response constraint validator** — deterministic safety floor

### v3 (after 3+ months of one user's data, or 10+ users)
- **Pattern mining** — weekly Claude job mines user's event stream for correlations, writes them as derived patterns with confidence
- **Intent classifier in orchestrator** — context assembly becomes conditional on user intent instead of always-load-everything

### v4 (when we have 50+ users with opt-in data sharing)
- **Cohort engine** — cluster users by profile similarity, surface evidence-backed interventions from outcome data
- **Outcome tracking** — track which suggestions actually moved metrics, feed back into cohort confidence scores

---

## Appendix: Glossary

- **Event** — A timestamped, immutable record of something that happened (HRV reading, meal logged, message sent).
- **Ontology** — The structured map of facts about a user, stored as nodes + edges in Postgres.
- **Node** — An entity in the ontology (Person, Condition, Goal, Habit).
- **Edge** — A relationship between two nodes (User has_allergy Peanut).
- **Hard constraint** — A fact that the coach must never violate (allergy, contraindicated activity).
- **Pattern** — A derived correlation in a user's data (e.g., "HRV drops after 10mi+ runs"). v3 only.
- **Cohort** — A cluster of users with similar profiles, used for evidence-backed recommendations. v4 only.
- **Tool** — A deterministic function Claude can call mid-conversation (calculate_macros, remember_fact, etc.).

---

## Sign-off

This doc captures what we agreed on in the 2026-05-16 brainstorm. Major decisions have rationale + cut criteria so they can be revisited intelligently later.

**Next actions:**
1. Friend reads this doc and leaves comments / pushback.
2. We sync and iterate any disagreements.
3. Lock v1 scope.
4. Move to implementation plan (which agent builds what, in what order).
