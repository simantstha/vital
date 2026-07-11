/**
 * Vital — Postgres schema (Drizzle ORM / pg-core)
 *
 * Design principles from docs/vital-architecture-v0.1.md §4–5:
 *  - Single Postgres DB, event-sourced architecture
 *  - All raw data is append-only in `events`; ontology is derived into nodes/edges
 *  - Confirmation-gated learning via `pending_facts` (v2 auto-extract pipeline seam)
 *  - `messages.sources` and `messages.metadata` are citation/insight seams for v2
 */

import * as p from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─── users ───────────────────────────────────────────────────────────────────
// apple_sub is nullable — populated once Sign in with Apple is wired up.

export const users = p.pgTable('users', {
  id:           p.uuid('id').primaryKey().defaultRandom(),
  apple_sub:    p.text('apple_sub').unique(),                                  // nullable; unique when present
  email:        p.text('email').notNull(),
  name:         p.text('name').notNull(),
  created_at:   p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  onboarded_at: p.timestamp('onboarded_at', { withTimezone: true }),           // nullable until onboarding flow completes
  timezone:     p.text('timezone'),                                            // IANA id (e.g. "America/Chicago"); null → UTC. Refreshed from the device on /api/today so day boundaries track travel.

  // ── Diet goal + budget ─────────────────────────────────────────────────────
  // goal drives the auto-calculated calorie/macro target (Mifflin-St Jeor TDEE
  // + goal adjustment; see lib/brain/dietBudget.ts). The *_target columns are a
  // user override: null in all four → "auto" (recompute from goal + weight);
  // set → the user has pinned their own numbers. Values: 'weight_loss' |
  // 'muscle' | 'endurance' | 'general'.
  goal:            p.text('goal'),                                             // nullable → treated as 'general'
  target_kcal:     p.integer('target_kcal'),                                   // null → auto
  protein_target_g: p.integer('protein_target_g'),
  carbs_target_g:   p.integer('carbs_target_g'),
  fat_target_g:     p.integer('fat_target_g'),
});

// ─── events (append-only) ────────────────────────────────────────────────────
// The immutable ledger. Nothing is ever updated or deleted here.
// Known event types (free-text, not enforced at DB level):
//   hrv_reading, sleep_session, workout_completed, steps_recorded,
//   meal_logged, weight_logged, lab_result, message_sent, message_received

export const events = p.pgTable('events', {
  id:        p.uuid('id').primaryKey().defaultRandom(),
  user_id:   p.uuid('user_id').notNull().references(() => users.id),
  timestamp: p.timestamp('timestamp', { withTimezone: true }).notNull(),
  type:      p.text('type').notNull(),
  payload:   p.jsonb('payload').notNull(),
  source:    p.text('source').notNull(),
}, (t) => [
  p.index('events_user_timestamp_idx').on(t.user_id, t.timestamp),
  p.index('events_user_type_timestamp_idx').on(t.user_id, t.type, t.timestamp),
]);

// ─── nodes (ontology) ────────────────────────────────────────────────────────
// Entities Vital knows about the user.
// Known node types (v1 closed schema): Person, Condition, Medication, Allergy,
//   Intolerance, Goal, Habit, FoodPreference, Cuisine, PantryItem,
//   LabMarker, Injury, FamilyHistory

export const nodes = p.pgTable('nodes', {
  id:         p.uuid('id').primaryKey().defaultRandom(),
  user_id:    p.uuid('user_id').notNull().references(() => users.id),
  type:       p.text('type').notNull(),
  label:      p.text('label').notNull(),
  properties: p.jsonb('properties'),                                            // nullable; extra metadata per node type
  source:     p.text('source').notNull(),
  weight:     p.real('weight').default(0.9).notNull(),
  created_at: p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.index('nodes_user_type_idx').on(t.user_id, t.type),
  p.index('nodes_user_label_idx').on(t.user_id, t.label),
]);

// ─── edges (ontology) ────────────────────────────────────────────────────────
// Relationships between ontology nodes.
// Known predicates (v1 closed schema): has_condition, has_allergy, has_intolerance,
//   takes_medication, has_family_member, has_goal, has_habit, prefers,
//   contains_ingredient, blocks_activity, last_value
//
// Weight rules (§5 Edge weight + reinforcement):
//   confirmed source  → 0.9
//   remember_fact call → 0.6
//   reinforced         → weight + 0.1 (capped at 1.0)
//   weekly decay       → weight × 0.95 (hard constraints never decay)

export const edges = p.pgTable('edges', {
  id:                 p.uuid('id').primaryKey().defaultRandom(),
  user_id:            p.uuid('user_id').notNull().references(() => users.id),
  from_node:          p.uuid('from_node').notNull().references(() => nodes.id),
  to_node:            p.uuid('to_node').notNull().references(() => nodes.id),
  predicate:          p.text('predicate').notNull(),
  properties:         p.jsonb('properties'),                                    // nullable; extra metadata per predicate
  weight:             p.real('weight').default(0.9).notNull(),
  source:             p.text('source').notNull(),
  created_at:         p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  last_reinforced_at: p.timestamp('last_reinforced_at', { withTimezone: true }), // nullable until first reinforcement
}, (t) => [
  p.index('edges_user_from_predicate_idx').on(t.user_id, t.from_node, t.predicate),
  p.index('edges_user_to_predicate_idx').on(t.user_id, t.to_node, t.predicate),
]);

// ─── messages ────────────────────────────────────────────────────────────────
// Full conversation history. Both role values: 'user' | 'assistant'
// sources:  v2 citation seam — populated when assistant reply is grounded in
//           specific events/nodes; defaults to [] so it's always query-safe.
// metadata: v2 structured-insights seam — structured coach analysis per reply.

export const messages = p.pgTable('messages', {
  id:         p.uuid('id').primaryKey().defaultRandom(),
  user_id:    p.uuid('user_id').notNull().references(() => users.id),
  timestamp:  p.timestamp('timestamp', { withTimezone: true }).notNull(),
  role:       p.text('role').notNull(),                                         // 'user' | 'assistant'
  content:    p.text('content').notNull(),
  tool_calls: p.jsonb('tool_calls'),                                            // nullable; present on assistant messages with tool use
  images:     p.jsonb('images'),                                                // nullable; base64 or storage refs
  sources:    p.jsonb('sources').default(sql`'[]'::jsonb`).notNull(),           // citation seam; always an array
  metadata:   p.jsonb('metadata'),                                              // structured insights seam; nullable
}, (t) => [
  p.index('messages_user_timestamp_idx').on(t.user_id, t.timestamp),
]);

// ─── pending_facts (confirmation-gated learning) ─────────────────────────────
// When the coach proposes a new fact via remember_fact(), it lands here as
// 'pending' until the user confirms or rejects it. Confirmed facts promote
// to nodes/edges. Rejected facts are retained for audit only.
// Either proposed_node or proposed_edge is populated (or both for a node+edge pair).
// status values: 'pending' | 'confirmed' | 'rejected'

export const pending_facts = p.pgTable('pending_facts', {
  id:            p.uuid('id').primaryKey().defaultRandom(),
  user_id:       p.uuid('user_id').notNull().references(() => users.id),
  proposed_node: p.jsonb('proposed_node'),                                      // nullable; shape mirrors nodes columns
  proposed_edge: p.jsonb('proposed_edge'),                                      // nullable; shape mirrors edges columns
  evidence:      p.text('evidence').notNull(),
  salience:      p.real('salience').notNull(),
  status:        p.text('status').default('pending').notNull(),                  // 'pending' | 'confirmed' | 'rejected'
  created_at:    p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolved_at:   p.timestamp('resolved_at', { withTimezone: true }),             // nullable until confirmed or rejected
}, (t) => [
  p.index('pending_facts_user_status_idx').on(t.user_id, t.status),
]);

// ─── daily_metrics ───────────────────────────────────────────────────────────
// Day-keyed HealthKit summaries, backfill + ongoing sync land here (not the
// events ledger) so upserts make backfill/retry/resume/re-sync idempotent
// structurally. Known metric names: hrv_sdnn, resting_hr, hr_avg, steps,
// active_energy_kcal, body_mass_kg, sleep_minutes (payload: stages),
// workouts (value = count, payload = array of workout entries w/ hkUuid).

export const daily_metrics = p.pgTable('daily_metrics', {
  id:         p.uuid('id').primaryKey().defaultRandom(),
  user_id:    p.uuid('user_id').notNull().references(() => users.id),
  date:       p.date('date').notNull(),
  metric:     p.text('metric').notNull(),
  value:      p.real('value').notNull(),
  payload:    p.jsonb('payload'),                                                // nullable; e.g. sleep stages, workout list
  source:     p.text('source').notNull(),
  updated_at: p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.uniqueIndex('daily_metrics_user_date_metric_idx').on(t.user_id, t.date, t.metric),
]);

// ─── baselines ───────────────────────────────────────────────────────────────
// One row per (user, metric) — recomputed from daily_metrics after every
// ingest. `established` gates the coach's recovery/training prescriptions
// (see lib/brain/baselines.ts getCalibration()).

export const baselines = p.pgTable('baselines', {
  id:          p.uuid('id').primaryKey().defaultRandom(),
  user_id:     p.uuid('user_id').notNull().references(() => users.id),
  metric:      p.text('metric').notNull(),
  stats:       p.jsonb('stats').notNull(),                                       // {mean7,mean30,mean60,sd30,p25,p50,p75}
  data_days:   p.integer('data_days').notNull(),
  established: p.boolean('established').default(false).notNull(),
  computed_at: p.timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.uniqueIndex('baselines_user_metric_idx').on(t.user_id, t.metric),
]);

// ─── pending_nudges ──────────────────────────────────────────────────────────
// Coach-scheduled nudges (schedule_nudge tool, lib/brain/tools.ts) plus any
// future proactive heuristics (steps drop, HRV trend, etc.). Local-notification
// bridge — no APNs: the iOS app's NudgeSyncer fetches sent_at IS NULL rows on
// foreground via GET /api/nudges, schedules each as a local one-shot
// (`vital.nudge.<id>`), then POSTs /api/nudges/ack to set sent_at = now().
// sent_at therefore means "a device fetched this and scheduled it locally",
// not "delivered to the user" — see docs/problems (D4 in the notifications
// plan) for the full ack-semantics rationale.

export const pending_nudges = p.pgTable('pending_nudges', {
  id:            p.uuid('id').primaryKey().defaultRandom(),
  user_id:       p.uuid('user_id').notNull().references(() => users.id),
  type:          p.text('type').notNull(),
  payload:       p.jsonb('payload').notNull(),
  scheduled_for: p.timestamp('scheduled_for', { withTimezone: true }).notNull(),
  sent_at:       p.timestamp('sent_at', { withTimezone: true }),                 // nullable until sent
}, (t) => [
  p.index('pending_nudges_user_scheduled_idx').on(t.user_id, t.scheduled_for),
]);

// ─── Inferred TypeScript types ────────────────────────────────────────────────
// Named to avoid collision with built-in DOM globals (Event, Node).

export type User          = typeof users.$inferSelect;
export type NewUser       = typeof users.$inferInsert;

export type DbEvent       = typeof events.$inferSelect;          // 'Event' conflicts with DOM Event
export type NewDbEvent    = typeof events.$inferInsert;

export type OntologyNode  = typeof nodes.$inferSelect;           // 'Node' conflicts with DOM Node
export type NewOntologyNode = typeof nodes.$inferInsert;

export type Edge          = typeof edges.$inferSelect;
export type NewEdge       = typeof edges.$inferInsert;

export type Message       = typeof messages.$inferSelect;
export type NewMessage    = typeof messages.$inferInsert;

export type PendingFact   = typeof pending_facts.$inferSelect;
export type NewPendingFact = typeof pending_facts.$inferInsert;

export type PendingNudge  = typeof pending_nudges.$inferSelect;
export type NewPendingNudge = typeof pending_nudges.$inferInsert;

export type DailyMetric    = typeof daily_metrics.$inferSelect;
export type NewDailyMetric = typeof daily_metrics.$inferInsert;

export type Baseline       = typeof baselines.$inferSelect;
export type NewBaseline    = typeof baselines.$inferInsert;
