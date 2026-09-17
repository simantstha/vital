/**
 * Vital Brain — memory curation persona block
 *
 * Governs how (and whether) the coach writes to the ontology. Every rule is
 * derived from the caller's actual tool allowlist — a rule that references a
 * tool the model can't call must never appear, because a prompt that
 * promises a capability the model doesn't have is exactly how the coach
 * once invented an "ontology team" to explain away a gap (see
 * groundingGuardrailBlock in persona.ts, the sibling guardrail this
 * complements). Specialists only ever get propose_fact + confirm_fact, so
 * their rendered block must never mention remember_fact, resolve_fact, or
 * query_ontology.
 */

export function memoryCurationBlock(availableTools: readonly string[]): string {
  const has = (name: string) => availableTools.includes(name);

  const canPropose = has('propose_fact');
  const canRemember = has('remember_fact');
  const canQuery = has('query_ontology');
  const canResolve = has('resolve_fact');
  const canWriteFacts = canPropose || canRemember || canResolve;

  const lines: string[] = [];

  if (canPropose || canRemember) {
    lines.push(
      `- Record only durable facts — allergies, conditions, medications, injuries, goals, ` +
      `standing preferences. Transient state ("tired today", "ate late") isn't memory; leave ` +
      `it in conversation.`,
    );
  }

  if (canQuery) {
    lines.push(
      `- Check before you write. Call \`query_ontology\` for an existing node before creating ` +
      `one — there's no uniqueness constraint, so a duplicate label persists forever.`,
    );
  }

  if (canResolve) {
    lines.push(
      `- Retract, don't duplicate. When a recorded fact stops being true (an injury healed, a ` +
      `medication stopped), call \`resolve_fact\` on the existing node. Never add a new node to ` +
      `represent a retraction, and never leave the old fact standing while telling the user it's gone.`,
    );
  }

  if (canPropose) {
    const rememberClause = canRemember
      ? ` \`remember_fact\` is for low-stakes facts the user stated plainly about themselves.`
      : '';
    lines.push(
      `- Mind the confirmation threshold. Allergy/Condition/Medication/Injury facts become hard ` +
      `constraints injected as "NEVER VIOLATE" — a mistaken one is permanent. Route those through ` +
      `\`propose_fact\` so the user confirms before it's binding.${rememberClause}`,
    );
  }

  if (canWriteFacts) {
    lines.push(
      `- Evidence is the user's own words. Whatever tool writes the fact, its evidence field must ` +
      `be a verbatim quote — never a paraphrase or inference. It's the only provenance that exists.`,
    );

    if (canRemember) {
      // remember_fact can scope a fact to a subject other than the user, so a
      // family member's fact has somewhere safe to live — file it there
      // instead of either attributing it to the user or dropping it.
      lines.push(
        `- Family members' health belongs to them, not the user. When a fact is about someone else ` +
        `(a parent's condition, a partner's allergy), pass \`subject\` to \`remember_fact\` so it's ` +
        `scoped to that person — never recorded as if it were true of the user.`,
      );
      lines.push(
        `- Entity filing. Before naming a new \`subject\`, check \`query_ontology\` for an entity ` +
        `that already covers them (by name or nickname) — reuse it so facts about the same person ` +
        `don't fragment across duplicate entities.`,
      );
      lines.push(
        `- Instances, not structure. Name new entities freely as they come up (a new person, pet, ` +
        `or place) — but never invent a new entity *kind* beyond Person, Pet, Place, or ` +
        `Organization. An unrecognised kind makes the graph unqueryable.`,
      );
    } else {
      // No remember_fact means no `subject` capability — the old, blunter
      // rule still applies: without entity scoping, a family member's fact
      // has nowhere safe to go, so don't record it at all.
      lines.push(
        `- Family members' health isn't the user's memory to keep. Record only what bears on the ` +
        `user's own care (e.g. heritable risk), and keep it factual.`,
      );
    }
  }

  if (lines.length === 0) return '';

  return `## Memory curation — how you write to the ontology\n${lines.join('\n')}`;
}
