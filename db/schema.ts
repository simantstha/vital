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

  // Manual "new chat" boundary (lib/brain/conversationWindow.ts). Set to now()
  // when the user taps "New chat"; messages at/before this timestamp are
  // excluded from both coach restore (GET /api/coach) and the LLM prompt
  // context (assembleContext), same as the automatic 4h-inactivity cutoff.
  chat_reset_at:   p.timestamp('chat_reset_at', { withTimezone: true }),

  // ── Sleep goal (redesign v3 Phase 9 — Profile personal details) ────────────
  // Same null-means-default convention as the diet targets above: null → the
  // app-level default is applied in code, not a DB default, so existing rows
  // pick up new defaults automatically if the default ever changes.
  sleep_goal_minutes:  p.integer('sleep_goal_minutes'),                        // null → 480 (8h)
  lights_out_minutes:  p.integer('lights_out_minutes'),                        // null → 1350 (22:30)
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

// ─── specialist_sessions ────────────────────────────────────────────────────
// Durable handoff lifecycle for scoped specialist consultations. Only proposal
// states expire; active consultations require an explicit return or failure.

export const specialist_sessions = p.pgTable('specialist_sessions', {
  id:                 p.uuid('id').primaryKey().defaultRandom(),
  user_id:            p.uuid('user_id').notNull().references(() => users.id),
  objective:          p.text('objective').notNull(),
  manifest_id:        p.text('manifest_id').notNull(),
  manifest_version:   p.text('manifest_version').notNull(),
  status:             p.text('status').default('proposed').notNull(),
  card_occurrence_id: p.uuid('card_occurrence_id').defaultRandom().notNull(),
  inbound_handoff:    p.jsonb('inbound_handoff').notNull(),
  return_handoff:     p.jsonb('return_handoff'),
  failure_reason:     p.text('failure_reason'),
  proposed_at:        p.timestamp('proposed_at', { withTimezone: true }).defaultNow().notNull(),
  activated_at:       p.timestamp('activated_at', { withTimezone: true }),
  return_proposed_at: p.timestamp('return_proposed_at', { withTimezone: true }),
  completed_at:       p.timestamp('completed_at', { withTimezone: true }),
  declined_at:        p.timestamp('declined_at', { withTimezone: true }),
  failed_at:          p.timestamp('failed_at', { withTimezone: true }),
  expires_at:         p.timestamp('expires_at', { withTimezone: true }),
  updated_at:         p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.check(
    'specialist_sessions_status_check',
    sql`${t.status} in ('proposed', 'active', 'return_proposed', 'completed', 'declined', 'failed')`,
  ),
  p.check(
    'specialist_sessions_expiry_check',
    sql`((${t.status} in ('proposed', 'return_proposed')) = (${t.expires_at} is not null))`,
  ),
  p.uniqueIndex('specialist_sessions_one_open_per_user_idx')
    .on(t.user_id)
    .where(sql`${t.status} in ('proposed', 'active', 'return_proposed')`),
  p.index('specialist_sessions_user_updated_idx').on(t.user_id, t.updated_at),
]);

// Idempotency ledger for explicit specialist-card actions. The stored result
// lets retries return the exact same ordered SSE payload without reapplying a
// session transition.
export const specialist_actions = p.pgTable('specialist_actions', {
  id:         p.uuid('id').primaryKey().defaultRandom(),
  user_id:    p.uuid('user_id').notNull().references(() => users.id),
  action_id:  p.text('action_id').notNull(),
  card_occurrence_id: p.uuid('card_occurrence_id').notNull(),
  session_id: p.uuid('session_id').notNull().references(() => specialist_sessions.id),
  action:     p.text('action').notNull(),
  result:     p.jsonb('result'),
  created_at: p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completed_at: p.timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  p.uniqueIndex('specialist_actions_user_action_idx').on(t.user_id, t.action_id),
  p.index('specialist_actions_session_idx').on(t.session_id),
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
  speaker:    p.text('speaker').notNull(),                                      // 'user' | 'coach' | 'specialist'
  content:    p.text('content').notNull(),
  tool_calls: p.jsonb('tool_calls'),                                            // nullable; present on assistant messages with tool use
  images:     p.jsonb('images'),                                                // nullable; base64 or storage refs
  sources:    p.jsonb('sources').default(sql`'[]'::jsonb`).notNull(),           // citation seam; always an array
  metadata:   p.jsonb('metadata'),                                              // structured insights seam; nullable
  specialist_session_id: p.uuid('specialist_session_id').references(() => specialist_sessions.id),
  specialist_metadata: p.jsonb('specialist_metadata'),                          // immutable identity/accent snapshot
}, (t) => [
  p.check(
    'messages_role_speaker_check',
    sql`((${t.role} = 'user' and ${t.speaker} = 'user') or (${t.role} = 'assistant' and ${t.speaker} in ('coach', 'specialist')))`,
  ),
  p.check(
    'messages_specialist_metadata_check',
    sql`((${t.speaker} = 'specialist' and ${t.specialist_session_id} is not null and ${t.specialist_metadata} is not null) or (${t.speaker} <> 'specialist' and ${t.specialist_session_id} is null and ${t.specialist_metadata} is null))`,
  ),
  p.index('messages_user_timestamp_idx').on(t.user_id, t.timestamp),
]);

// ─── pending_facts (confirmation-gated learning) ─────────────────────────────
// When the coach proposes a new fact via propose_fact(), it lands here as
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
// Nudges scheduled by the proactive heuristics cron (steps drop, HRV trend, etc.)
// sent_at is null until the nudge is dispatched via APNs.

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

// ─── proactive health analysis + push delivery ─────────────────────────────

export const push_devices = p.pgTable('push_devices', {
  id:              p.uuid('id').primaryKey().defaultRandom(),
  user_id:         p.uuid('user_id').notNull().references(() => users.id),
  installation_id: p.text('installation_id').notNull(),
  device_token:    p.text('device_token').notNull(),
  environment:     p.text('environment').notNull(),
  created_at:      p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at:      p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  invalidated_at:  p.timestamp('invalidated_at', { withTimezone: true }),
}, (t) => [
  p.check('push_devices_environment_check', sql`${t.environment} in ('sandbox', 'production')`),
  p.uniqueIndex('push_devices_installation_idx').on(t.installation_id),
  p.uniqueIndex('push_devices_token_environment_idx').on(t.device_token, t.environment),
  p.index('push_devices_user_active_idx').on(t.user_id, t.invalidated_at),
]);

export const notification_preferences = p.pgTable('notification_preferences', {
  user_id:                       p.uuid('user_id').primaryKey().references(() => users.id),
  morning_brief_enabled:         p.boolean('morning_brief_enabled').default(true).notNull(),
  morning_brief_time_minutes:    p.integer('morning_brief_time_minutes').default(450).notNull(),
  workout_notifications_enabled: p.boolean('workout_notifications_enabled').default(true).notNull(),
  sleep_notifications_enabled:   p.boolean('sleep_notifications_enabled').default(true).notNull(),
  meals_enabled:                 p.boolean('meals_enabled').default(true).notNull(),
  meal_breakfast_time_minutes:   p.integer('meal_breakfast_time_minutes').default(480).notNull(),
  meal_lunch_time_minutes:       p.integer('meal_lunch_time_minutes').default(765).notNull(),
  meal_snack_time_minutes:       p.integer('meal_snack_time_minutes').default(960).notNull(),
  meal_dinner_time_minutes:      p.integer('meal_dinner_time_minutes').default(1170).notNull(),
  timezone:                      p.text('timezone').default('UTC').notNull(),
  updated_at:                    p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.check(
    'notification_preferences_morning_time_check',
    sql`${t.morning_brief_time_minutes} between 0 and 1439`,
  ),
  p.check(
    'notification_preferences_meal_breakfast_time_check',
    sql`${t.meal_breakfast_time_minutes} between 0 and 1439`,
  ),
  p.check(
    'notification_preferences_meal_lunch_time_check',
    sql`${t.meal_lunch_time_minutes} between 0 and 1439`,
  ),
  p.check(
    'notification_preferences_meal_snack_time_check',
    sql`${t.meal_snack_time_minutes} between 0 and 1439`,
  ),
  p.check(
    'notification_preferences_meal_dinner_time_check',
    sql`${t.meal_dinner_time_minutes} between 0 and 1439`,
  ),
]);

export const workout_analyses = p.pgTable('workout_analyses', {
  id:                 p.uuid('id').primaryKey().defaultRandom(),
  user_id:            p.uuid('user_id').notNull().references(() => users.id),
  hk_uuid:            p.text('hk_uuid').notNull(),
  workout_date:       p.date('workout_date').notNull(),
  content_fingerprint: p.text('content_fingerprint').notNull(),
  input_payload:      p.jsonb('input_payload').notNull(),
  status:             p.text('status').default('pending').notNull(),
  retry_count:        p.integer('retry_count').default(0).notNull(),
  next_attempt_at:    p.timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  lease_expires_at:   p.timestamp('lease_expires_at', { withTimezone: true }),
  lease_token:        p.uuid('lease_token'),
  result:             p.jsonb('result'),
  notification_state: p.text('notification_state').default('pending').notNull(),
  notification_sent_at: p.timestamp('notification_sent_at', { withTimezone: true }),
  notification_lease_token: p.uuid('notification_lease_token'),
  notification_lease_expires_at: p.timestamp('notification_lease_expires_at', { withTimezone: true }),
  notification_retry_count: p.integer('notification_retry_count').default(0).notNull(),
  notification_next_attempt_at: p.timestamp('notification_next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  created_at:         p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at:         p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deleted_at:         p.timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  p.check('workout_analyses_status_check', sql`${t.status} in ('pending', 'processing', 'ready', 'failed', 'deleted')`),
  p.check('workout_analyses_notification_state_check', sql`${t.notification_state} in ('pending', 'suppressed', 'sending', 'sent', 'failed')`),
  p.uniqueIndex('workout_analyses_user_hk_uuid_idx').on(t.user_id, t.hk_uuid),
  p.index('workout_analyses_queue_idx').on(t.status, t.next_attempt_at),
]);

export const sleep_analyses = p.pgTable('sleep_analyses', {
  id:                 p.uuid('id').primaryKey().defaultRandom(),
  user_id:            p.uuid('user_id').notNull().references(() => users.id),
  wake_date:          p.date('wake_date').notNull(),
  content_fingerprint: p.text('content_fingerprint').notNull(),
  input_payload:      p.jsonb('input_payload').notNull(),
  analyze_after:      p.timestamp('analyze_after', { withTimezone: true }).notNull(),
  status:             p.text('status').default('pending').notNull(),
  retry_count:        p.integer('retry_count').default(0).notNull(),
  next_attempt_at:    p.timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  lease_expires_at:   p.timestamp('lease_expires_at', { withTimezone: true }),
  lease_token:        p.uuid('lease_token'),
  result:             p.jsonb('result'),
  notification_state: p.text('notification_state').default('pending').notNull(),
  notification_sent_at: p.timestamp('notification_sent_at', { withTimezone: true }),
  notification_lease_token: p.uuid('notification_lease_token'),
  notification_lease_expires_at: p.timestamp('notification_lease_expires_at', { withTimezone: true }),
  notification_retry_count: p.integer('notification_retry_count').default(0).notNull(),
  notification_next_attempt_at: p.timestamp('notification_next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  created_at:         p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at:         p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.check('sleep_analyses_status_check', sql`${t.status} in ('pending', 'processing', 'ready', 'failed', 'deleted')`),
  p.check('sleep_analyses_notification_state_check', sql`${t.notification_state} in ('pending', 'suppressed', 'sending', 'sent', 'failed')`),
  p.uniqueIndex('sleep_analyses_user_wake_date_idx').on(t.user_id, t.wake_date),
  p.index('sleep_analyses_queue_idx').on(t.status, t.next_attempt_at),
]);

export const morning_notification_slots = p.pgTable('morning_notification_slots', {
  id:              p.uuid('id').primaryKey().defaultRandom(),
  user_id:         p.uuid('user_id').notNull().references(() => users.id),
  local_date:      p.date('local_date').notNull(),
  claimed_by:      p.text('claimed_by').notNull(),
  status:          p.text('status').default('claimed').notNull(),
  idempotency_key: p.text('idempotency_key').notNull(),
  claimed_at:      p.timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  sent_at:         p.timestamp('sent_at', { withTimezone: true }),
  lease_token:     p.uuid('lease_token'),
  lease_expires_at: p.timestamp('lease_expires_at', { withTimezone: true }),
  retry_count:     p.integer('retry_count').default(0).notNull(),
  next_attempt_at: p.timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.check('morning_notification_slots_claimed_by_check', sql`${t.claimed_by} in ('sleep', 'brief')`),
  p.check('morning_notification_slots_status_check', sql`${t.status} in ('claimed', 'sent', 'failed')`),
  p.uniqueIndex('morning_notification_slots_user_date_idx').on(t.user_id, t.local_date),
  p.uniqueIndex('morning_notification_slots_idempotency_idx').on(t.idempotency_key),
]);

export const push_attempts = p.pgTable('push_attempts', {
  id:              p.uuid('id').primaryKey().defaultRandom(),
  user_id:         p.uuid('user_id').notNull().references(() => users.id),
  push_device_id:  p.uuid('push_device_id').references(() => push_devices.id),
  idempotency_key: p.text('idempotency_key').notNull(),
  notification_type: p.text('notification_type').notNull(),
  target_id:       p.uuid('target_id'),
  attempt_number:  p.integer('attempt_number').default(1).notNull(),
  status:          p.text('status').default('pending').notNull(),
  apns_status:     p.integer('apns_status'),
  failure_category: p.text('failure_category'),
  latency_ms:      p.integer('latency_ms'),
  attempted_at:    p.timestamp('attempted_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.check('push_attempts_status_check', sql`${t.status} in ('pending', 'sent', 'transient_failure', 'permanent_failure')`),
  p.uniqueIndex('push_attempts_idempotency_attempt_idx').on(t.idempotency_key, t.attempt_number),
  p.index('push_attempts_user_attempted_idx').on(t.user_id, t.attempted_at),
]);

// ─── plan_items ──────────────────────────────────────────────────────────────
// Server-persisted rows for the Today "plan" timeline (redesign v3 Phase 2).
// One row per plan entry per (user, local calendar day) — local_day is a
// YYYY-MM-DD key using the same convention as `lib/localDay.ts`. Seeded
// additively from the cached daily brief's meals + a synthetic sleep item
// (see app/api/plan/route.ts); user-added items get source='user'.
// Calendar busy blocks with titles now sync to `calendar_blocks` below with
// user consent (titles only — never locations/attendees/notes); plan_items
// itself still never stores calendar events — merged client-side only.
// status values: 'pending' | 'done' | 'skipped'. kind values: 'meal' | 'move'
// | 'rest' | 'sleep' | 'other'. source values: 'coach' | 'user'.

export const plan_items = p.pgTable('plan_items', {
  id:           p.uuid('id').primaryKey().defaultRandom(),
  user_id:      p.uuid('user_id').notNull().references(() => users.id),
  local_day:    p.text('local_day').notNull(),
  time_minutes: p.integer('time_minutes').notNull(),                          // minutes from local midnight
  title:        p.text('title').notNull(),
  subtitle:     p.text('subtitle'),                                          // nullable
  kind:         p.text('kind').notNull(),                                     // meal | move | rest | sleep | other
  source:       p.text('source').notNull(),                                   // coach | user
  status:       p.text('status').default('pending').notNull(),                // pending | done | skipped
  kcal:         p.integer('kcal'),                                            // nullable — meals only
  created_at:   p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at:   p.timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.index('plan_items_user_day_idx').on(t.user_id, t.local_day),
]);

// ─── calendar_blocks ─────────────────────────────────────────────────────────
// Coach calendar awareness (see docs Calendar Integration plan). iOS syncs
// EventKit busy blocks here with explicit user consent — title only, never
// location/attendees/notes. Full-replace sync: a POST to
// /api/ingest/calendar deletes existing rows overlapping the posted window
// for the user, then bulk-inserts the fresh set, so re-posting the same
// window is idempotent by construction (no dedup key needed).

export const calendar_blocks = p.pgTable('calendar_blocks', {
  id:         p.uuid('id').primaryKey().defaultRandom(),
  user_id:    p.uuid('user_id').notNull().references(() => users.id),
  start_at:   p.timestamp('start_at', { withTimezone: true }).notNull(),
  end_at:     p.timestamp('end_at', { withTimezone: true }).notNull(),
  all_day:    p.boolean('all_day').default(false).notNull(),
  title:      p.text('title'),                                                // nullable — "Busy" fallback when absent
  synced_at:  p.timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.index('calendar_blocks_user_start_idx').on(t.user_id, t.start_at),
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

export type SpecialistSession = typeof specialist_sessions.$inferSelect;
export type NewSpecialistSession = typeof specialist_sessions.$inferInsert;

export type PendingFact   = typeof pending_facts.$inferSelect;
export type NewPendingFact = typeof pending_facts.$inferInsert;

export type PendingNudge  = typeof pending_nudges.$inferSelect;
export type NewPendingNudge = typeof pending_nudges.$inferInsert;

export type DailyMetric    = typeof daily_metrics.$inferSelect;
export type NewDailyMetric = typeof daily_metrics.$inferInsert;

export type Baseline       = typeof baselines.$inferSelect;
export type NewBaseline    = typeof baselines.$inferInsert;

export type PlanItemRow    = typeof plan_items.$inferSelect;                  // 'PlanItem' avoided — collides with iOS-side name in spirit, not compilation, but keep distinct
export type NewPlanItemRow = typeof plan_items.$inferInsert;

export type CalendarBlock    = typeof calendar_blocks.$inferSelect;
export type NewCalendarBlock = typeof calendar_blocks.$inferInsert;

export type PushDevice = typeof push_devices.$inferSelect;
export type NotificationPreference = typeof notification_preferences.$inferSelect;
export type WorkoutAnalysis = typeof workout_analyses.$inferSelect;
export type SleepAnalysis = typeof sleep_analyses.$inferSelect;
