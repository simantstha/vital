# Memory Curation — Ontology Writing Rules

The coach writes to the `nodes` ontology table through a persona block assembled by `assemblePersona()` in `lib/brain/persona.ts` (main coach) and `buildSpecialistPrompt()` in `lib/specialists/orchestration.ts` (specialists). The block is rendered by `memoryCurationBlock(availableTools)` in `lib/brain/memoryCuration.ts` and governs what facts the model records and how.

## Why rules derive from the tool allowlist

The central design property: a prompt that names a tool the model cannot call invites the model to claim it did something it didn't. This already happened — the coach once invented a non-existent "ontology team" to explain a capability gap (see `groundingGuardrailBlock()` in persona.ts). By deriving each rule from `availableTools` rather than hardcoding them, we make mismatch structurally impossible: a rule naming `remember_fact` is emitted only when `remember_fact` is in the allowlist, so the prompt can never advertise a tool the model lacks.

Specialists get only `propose_fact` + `confirm_fact` (see `lib/specialists/registry.ts`), so their rendered block never mentions `remember_fact`, `resolve_fact`, or `query_ontology` — the model cannot misunderstand what it can do.

## The six rules

**Durable facts only**

Record allergies, conditions, medications, injuries, goals, standing preferences — not transient state. "Tired today" or "ate late" stays in conversation; it's not memory.

**Check before you write**

Call `query_ontology` before creating a fact. There is no uniqueness constraint on (user_id, type, label), so a duplicate label persists forever once recorded.

**Retract, don't duplicate**

When a recorded fact stops being true (an injury healed, a medication stopped), call `resolve_fact` on the existing node. Never add a new node to represent a retraction, and never leave the old fact standing. This rule closes the gap: a gate once went 1→2 when the coach should have retracted the first node.

**Mind the confirmation threshold**

Allergy/Condition/Medication/Injury facts become hard constraints injected as "NEVER VIOLATE" — a mistaken one is permanent. Route those through `propose_fact` (waiting for user confirmation) rather than `remember_fact` (lower-stakes facts the user stated plainly).

**Evidence is verbatim**

Whatever tool writes the fact, its evidence field must be the user's own words — never a paraphrase or inference. Verbatim quotes are the only provenance that exists.

**Family health is scoped, not banned**

Record only what bears on the user's own care (e.g. heritable risk), and keep it factual. This is a scoping rule, not a prohibition — a family member's condition is recordable when it is relevant to the user; what it rules out is keeping someone else's health history as if it were the user's.

## Where the rules came from

Two shipped bugs:

1. **Duplicate nodes** (2026-08-11): The user said "my injury healed" and the coach added a second node instead of resolving the first. A gate counting matching active nodes went 1→2, so the fact never cleared. The retract-don't-duplicate rule closes this.

2. **Retracted facts leaked** (2026-09-16): All seven other `nodes` readers already filtered `status='active'`; exactly one (`lib/proactiveHealthWorkerRepository.ts`) was missing it, so resolved facts like "my injury healed" fed every workout and sleep analysis prompt indefinitely. This was a read-path bug — no curation rule would have prevented it — but it is why rule 3 matters: a fact the coach believes it retracted is only actually gone if every reader honours the lifecycle.

## This block is compiled into the binary, not read from disk

The block ships as compiled prompt text, never read from disk at runtime. This is deliberate: per-user memory used to live in files on a Fly volume. Fly volumes are single-attach (mounting on both processes = a second empty volume), so the worker process read a blank re-seeded template for every morning brief. Prompt content must never depend on that volume again. By compiling the block at build time, it is identical for every invocation and every user.

## What's deliberately not here yet

**Entity filing** (who a fact is about) waits on a `subject_node_id` column. Once that schema exists, the block can teach the model to tag facts with the person they're about — "my mother has diabetes" vs "I have diabetes". Until then, there is no rule because there is no mechanism.

**Supersede vs retract** waits on a `superseded_by` column. The distinction between "this fact is no longer true" (retract) and "this newer fact replaces the old one" (supersede, preserving the old for reference) is a deferred design. A rule that describes a capability that doesn't exist yet is a liability.
