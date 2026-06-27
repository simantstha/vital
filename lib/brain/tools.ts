/**
 * Vital Brain — tool definitions + executors
 *
 * Anthropic tool definitions for the coach loop + deterministic executor
 * functions backed by Drizzle. All math is computed in code, never by the LLM.
 *
 * Tool inventory:
 *   query_events      — read events table by type + date range
 *   query_ontology    — read nodes/edges
 *   calculate_macros  — deterministic TDEE + macro split (no LLM math)
 *   remember_fact     — write node/edge to ontology (weight 0.6)
 *   confirm_fact      — resolve a pending_fact to confirmed/rejected
 *   log_meal          — nutrition lookup → meal_logged event
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { db, schema } from '@/db';
import { eq, and, gte, desc } from 'drizzle-orm';
import { lookupNutrition } from '@/lib/nutritionix';
import { lookupBarcode } from '@/lib/openFoodFacts';

// ── Tool definitions (Anthropic API schema) ────────────────────────────────

export const BRAIN_TOOLS: Tool[] = [
  {
    name: 'query_events',
    description:
      'Query the user\'s event ledger for a specific event type over a date range. ' +
      'Returns JSON array of { timestamp, payload } objects ordered newest first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description:
            'Event type to filter. Known types: hrv_reading, sleep_session, ' +
            'workout_completed, steps_recorded, meal_logged, weight_logged, lab_result.',
        },
        rangeDays: {
          type: 'number',
          description: 'How many days back to search (1 = today only, 7 = last week, etc.).',
        },
      },
      required: ['type', 'rangeDays'],
    },
  },
  {
    name: 'query_ontology',
    description:
      'Query the user\'s ontology (structured facts: goals, allergies, conditions, ' +
      'preferences, medications, injuries). Optionally filter by node type or label.',
    input_schema: {
      type: 'object' as const,
      properties: {
        nodeType: {
          type: 'string',
          description:
            'Optional node type to filter. Valid types: Person, Condition, Medication, ' +
            'Allergy, Intolerance, Goal, Habit, FoodPreference, Cuisine, PantryItem, ' +
            'LabMarker, Injury, FamilyHistory.',
        },
        labelContains: {
          type: 'string',
          description: 'Optional substring to filter node labels (case-insensitive).',
        },
      },
      required: [],
    },
  },
  {
    name: 'calculate_macros',
    description:
      'Deterministic TDEE and macro calculation. Inputs: user\'s goal, weight, ' +
      'and today\'s workouts. Returns daily calorie target + macro grams (C/P/F). ' +
      'Always use this for numbers — never compute macros from context text.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string',
          enum: ['weight_loss', 'muscle', 'endurance', 'general'],
          description: 'The user\'s primary nutrition goal.',
        },
        weightKg: {
          type: 'number',
          description: 'User\'s current body weight in kilograms.',
        },
        todayWorkouts: {
          type: 'array',
          description: 'Workouts completed today. Provide an empty array if none.',
          items: {
            type: 'object',
            properties: {
              type:        { type: 'string', description: 'e.g. running, cycling, strength, walk' },
              distanceKm:  { type: 'number', description: 'Distance in km (optional).' },
              durationMin: { type: 'number', description: 'Duration in minutes (optional).' },
              calories:    { type: 'number', description: 'Active calories if known (overrides estimate).' },
            },
            required: ['type'],
          },
        },
      },
      required: ['goal', 'weightKg', 'todayWorkouts'],
    },
  },
  {
    name: 'remember_fact',
    description:
      'Persist a new fact about the user to the ontology. Use when the user reveals ' +
      'an allergy, condition, medication, goal, food preference, or any other ' +
      'structured fact worth remembering permanently. Creates a node (weight 0.6).',
    input_schema: {
      type: 'object' as const,
      properties: {
        nodeType: {
          type: 'string',
          description:
            'Node type. One of: Condition, Medication, Allergy, Intolerance, Goal, ' +
            'Habit, FoodPreference, Cuisine, PantryItem, LabMarker, Injury, FamilyHistory.',
        },
        label: {
          type: 'string',
          description: 'Short label for the fact, e.g. "Peanut allergy" or "Marathon runner".',
        },
        evidence: {
          type: 'string',
          description: 'The exact user quote or signal that surfaced this fact.',
        },
        linksTo: {
          type: 'string',
          description:
            'Optional label of an existing node to create an edge to. ' +
            'E.g. if remembering an Injury, linksTo might be the activity it affects.',
        },
      },
      required: ['nodeType', 'label', 'evidence'],
    },
  },
  {
    name: 'confirm_fact',
    description:
      'Resolve a pending fact (confirm or reject). Use when the user explicitly ' +
      'confirms or denies a fact the coach proposed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        factId: {
          type: 'string',
          description: 'UUID of the pending_fact row to resolve.',
        },
        action: {
          type: 'string',
          enum: ['confirm', 'reject'],
          description: 'Whether to confirm (promote to ontology) or reject the fact.',
        },
      },
      required: ['factId', 'action'],
    },
  },
  {
    name: 'log_meal',
    description:
      'Look up nutrition for a food description or barcode and write a meal_logged ' +
      'event to the database. Use when the user reports eating something.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description:
            'Food description (e.g. "200g grilled chicken and rice") or a barcode ' +
            'number (all digits, e.g. "0123456789"). The tool auto-detects which.',
        },
        grams: {
          type: 'number',
          description:
            'Optional serving size override in grams (only applies when text is a barcode).',
        },
      },
      required: ['text'],
    },
  },
];

// ── Deterministic macro math ──────────────────────────────────────────────────

interface WorkoutInput {
  type: string;
  distanceKm?: number;
  durationMin?: number;
  calories?: number;
}

function estimateTDEE(weightKg: number, workouts: WorkoutInput[]): number {
  // Mifflin-St Jeor for 175 cm, 30-year-old male (profile defaults)
  const bmr = 10 * weightKg + 6.25 * 175 - 5 * 30 + 5;
  let tdee = bmr * 1.3; // lightly-active base

  for (const w of workouts) {
    if (w.calories != null && w.calories > 0) {
      tdee += w.calories;
      continue;
    }
    const t = w.type.toLowerCase();
    const durMin = w.durationMin ?? 0;
    const distKm = w.distanceKm ?? 0;

    if (t.includes('run')) {
      tdee += distKm > 0 ? weightKg * distKm * 1.0 : durMin * 11;
    } else if (t.includes('cycl') || t.includes('bike')) {
      tdee += distKm > 0 ? weightKg * distKm * 0.5 : durMin * 8;
    } else if (t.includes('swim')) {
      tdee += durMin * 9;
    } else if (
      t.includes('strength') || t.includes('gym') ||
      t.includes('weight') || t.includes('lift')
    ) {
      tdee += durMin * 4;
    } else if (t.includes('walk') || t.includes('hike')) {
      tdee += distKm > 0 ? weightKg * distKm * 0.5 : durMin * 4;
    } else {
      tdee += durMin * 6; // generic activity
    }
  }

  return Math.round(tdee);
}

function macrosForGoal(
  goal: string,
  weightKg: number,
  tdee: number,
): { targetCal: number; c: number; p: number; f: number } {
  let targetCal: number;
  let proteinGPerKg: number;
  let fatFraction: number;

  switch (goal) {
    case 'weight_loss':
      targetCal    = tdee - 400;
      proteinGPerKg = 2.2;
      fatFraction   = 0.27;
      break;
    case 'muscle':
      targetCal    = tdee + 200;
      proteinGPerKg = 2.0;
      fatFraction   = 0.26;
      break;
    case 'endurance':
      targetCal    = tdee + 100;
      proteinGPerKg = 1.6;
      fatFraction   = 0.22;
      break;
    default: // 'general'
      targetCal    = tdee;
      proteinGPerKg = 1.6;
      fatFraction   = 0.27;
  }

  const p    = Math.round(proteinGPerKg * weightKg);
  const fKcal = Math.round(targetCal * fatFraction);
  const f    = Math.round(fKcal / 9);
  const cKcal = Math.max(0, targetCal - p * 4 - fKcal);
  const c    = Math.round(cKcal / 4);

  return { targetCal: Math.round(targetCal), c, p, f };
}

// ── Ontology helper ────────────────────────────────────────────────────────────

function predicateFor(nodeType: string): string {
  const map: Record<string, string> = {
    Condition:      'has_condition',
    Allergy:        'has_allergy',
    Intolerance:    'has_intolerance',
    Medication:     'takes_medication',
    FamilyHistory:  'has_family_member',
    Goal:           'has_goal',
    Habit:          'has_habit',
    FoodPreference: 'prefers',
    Cuisine:        'prefers',
    PantryItem:     'contains_ingredient',
    Injury:         'blocks_activity',
    LabMarker:      'last_value',
  };
  return map[nodeType] ?? 'related_to';
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  userId: string,
): Promise<string> {
  // ── query_events ──────────────────────────────────────────────────────────
  if (name === 'query_events') {
    const type      = String(input.type ?? '');
    const rangeDays = Math.max(1, Math.min(90, Number(input.rangeDays ?? 7)));

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - rangeDays);

    const rows = await db
      .select({ timestamp: schema.events.timestamp, payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.user_id, userId),
          eq(schema.events.type, type),
          gte(schema.events.timestamp, since),
        ),
      )
      .orderBy(desc(schema.events.timestamp))
      .limit(100);

    return JSON.stringify(rows);
  }

  // ── query_ontology ────────────────────────────────────────────────────────
  if (name === 'query_ontology') {
    const nodeType     = input.nodeType != null ? String(input.nodeType) : null;
    const labelContains = input.labelContains != null ? String(input.labelContains).toLowerCase() : null;

    let rows = await db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.user_id, userId))
      .orderBy(desc(schema.nodes.weight));

    if (nodeType) rows = rows.filter(n => n.type === nodeType);
    if (labelContains) rows = rows.filter(n => n.label.toLowerCase().includes(labelContains));

    return JSON.stringify(rows);
  }

  // ── calculate_macros ──────────────────────────────────────────────────────
  if (name === 'calculate_macros') {
    const goal     = String(input.goal ?? 'general');
    const weightKg = Number(input.weightKg ?? 70);
    const workouts = Array.isArray(input.todayWorkouts)
      ? (input.todayWorkouts as WorkoutInput[])
      : [];

    const tdee = estimateTDEE(weightKg, workouts);
    const { targetCal, c, p, f } = macrosForGoal(goal, weightKg, tdee);

    return JSON.stringify({
      tdee,
      targetCal,
      macros: { c, p, f },
      note: `TDEE ${tdee} kcal · goal adjustment → ${targetCal} kcal · ${c}g C / ${p}g P / ${f}g F`,
    });
  }

  // ── remember_fact ─────────────────────────────────────────────────────────
  if (name === 'remember_fact') {
    const nodeType = String(input.nodeType ?? 'Habit');
    const label    = String(input.label ?? '');
    const evidence = String(input.evidence ?? '');
    const linksTo  = input.linksTo != null ? String(input.linksTo) : null;

    if (!label) return 'Error: label is required.';

    // Insert the new node with weight 0.6 (coach-proposed)
    const [newNode] = await db
      .insert(schema.nodes)
      .values({
        user_id:    userId,
        type:       nodeType,
        label,
        properties: { evidence },
        source:     'coach',
        weight:     0.6,
      })
      .returning({ id: schema.nodes.id });

    // Optionally link to an existing node whose label matches linksTo
    if (linksTo) {
      const allNodes = await db
        .select({ id: schema.nodes.id, label: schema.nodes.label })
        .from(schema.nodes)
        .where(eq(schema.nodes.user_id, userId));

      const toNode = allNodes.find(
        n => n.label.toLowerCase() === linksTo.toLowerCase(),
      );

      if (toNode) {
        await db.insert(schema.edges).values({
          user_id:   userId,
          from_node: newNode.id,
          to_node:   toNode.id,
          predicate: predicateFor(nodeType),
          source:    'coach',
          weight:    0.6,
        });
      }
    }

    return JSON.stringify({ ok: true, nodeId: newNode.id, label, nodeType });
  }

  // ── confirm_fact ──────────────────────────────────────────────────────────
  if (name === 'confirm_fact') {
    const factId = String(input.factId ?? '');
    const action = String(input.action ?? 'confirm') as 'confirm' | 'reject';

    if (!factId) return 'Error: factId is required.';

    const status     = action === 'confirm' ? 'confirmed' : 'rejected';
    const resolvedAt = new Date();

    const [updated] = await db
      .update(schema.pending_facts)
      .set({ status, resolved_at: resolvedAt })
      .where(eq(schema.pending_facts.id, factId))
      .returning({ id: schema.pending_facts.id, proposed_node: schema.pending_facts.proposed_node });

    if (!updated) return `No pending_fact found with id ${factId}.`;

    // If confirmed, promote the proposed node/edge to the ontology
    if (action === 'confirm' && updated.proposed_node) {
      const proposed = updated.proposed_node as Record<string, unknown>;
      await db.insert(schema.nodes).values({
        user_id:    userId,
        type:       String(proposed.type ?? 'Habit'),
        label:      String(proposed.label ?? ''),
        properties: proposed.properties as Record<string, unknown> | null,
        source:     'confirmed',
        weight:     0.9,
      }).onConflictDoNothing();
    }

    return JSON.stringify({ ok: true, factId, status });
  }

  // ── log_meal ──────────────────────────────────────────────────────────────
  if (name === 'log_meal') {
    const text  = String(input.text ?? '');
    const grams = input.grams != null ? Number(input.grams) : null;

    if (!text) return 'Error: text is required.';

    // Barcode path: all digits (8–14 chars)
    if (/^\d{8,14}$/.test(text.trim())) {
      const product = await lookupBarcode(text.trim());
      if (!product) return `Barcode ${text} not found in Open Food Facts.`;

      const servingG  = grams ?? 100;
      const factor    = servingG / 100;
      const kcal      = Math.round(product.per100g.kcal * factor);
      const c         = Math.round(product.per100g.c    * factor);
      const p         = Math.round(product.per100g.p    * factor);
      const f         = Math.round(product.per100g.f    * factor);

      await db.insert(schema.events).values({
        user_id:   userId,
        timestamp: new Date(),
        type:      'meal_logged',
        payload:   { kcal, c, p, f, description: `${product.productName} ${servingG}g`, source: 'barcode' },
        source:    'coach',
      });

      return JSON.stringify({
        ok: true,
        product: product.productName,
        servingG,
        kcal, c, p, f,
      });
    }

    // Text/description path — CalorieNinjas lookup
    const nutrition = await lookupNutrition(text);
    if (!nutrition) {
      return `Could not find nutrition data for "${text}". Try being more specific, e.g. "200g grilled chicken breast".`;
    }

    await db.insert(schema.events).values({
      user_id:   userId,
      timestamp: new Date(),
      type:      'meal_logged',
      payload:   {
        kcal:        nutrition.kcal,
        c:           nutrition.c,
        p:           nutrition.p,
        f:           nutrition.f,
        description: text,
        items:       nutrition.foods.map(fd => `${fd.qty}${fd.unit} ${fd.name}`).join(', '),
        source:      'calorieninjas',
      },
      source: 'coach',
    });

    return JSON.stringify({
      ok: true,
      query: text,
      kcal: nutrition.kcal,
      c: nutrition.c,
      p: nutrition.p,
      f: nutrition.f,
      foods: nutrition.foods,
    });
  }

  return `Unknown tool: ${name}`;
}
