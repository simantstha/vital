/**
 * Vital — dev seed script
 *
 * Inserts ~14 days of realistic past biometric + activity + nutrition events
 * for the dev@vital.local user, plus 2 sample pending_facts.
 * Safe to re-run: deletes prior seeded rows (tagged `seed:true` in payload)
 * before re-inserting.
 *
 * Run with:
 *   npx tsx scripts/seed-dev.ts
 */

// ── Deterministic seed data ────────────────────────────────────────────────────
// Index 0 = yesterday (day -1), index 13 = 14 days ago (day -14).

// HRV: SDNN in ms — slight upward trend toward the present
const HRV_VALUES = [74, 68, 71, 69, 64, 67, 62, 65, 63, 59, 61, 58, 55, 57];

// Sleep: [duration_ms, efficiency %, resting_hr bpm]
const SLEEP_DATA: [number, number, number][] = [
  [7.8 * 3_600_000, 90, 50],   // day -1  (yesterday)
  [7.4 * 3_600_000, 87, 51],   // day -2
  [8.0 * 3_600_000, 91, 50],   // day -3
  [7.6 * 3_600_000, 89, 50],   // day -4
  [6.9 * 3_600_000, 83, 52],   // day -5
  [7.3 * 3_600_000, 86, 51],   // day -6
  [7.8 * 3_600_000, 90, 50],   // day -7
  [6.7 * 3_600_000, 79, 53],   // day -8
  [7.1 * 3_600_000, 84, 51],   // day -9
  [8.0 * 3_600_000, 92, 51],   // day -10
  [7.5 * 3_600_000, 88, 52],   // day -11
  [6.8 * 3_600_000, 82, 52],   // day -12
  [7.2 * 3_600_000, 85, 53],   // day -13
  [6.5 * 3_600_000, 81, 54],   // day -14
];

// Steps: count per day
const STEPS_VALUES = [9432, 8901, 13056, 10234, 7654, 9876, 12089, 4321, 8456, 11023, 6789, 9234, 5421, 7823];

// Weight (kg) on specific days — key = day index (1-based from yesterday)
const WEIGHT_DAYS: Record<number, number> = {
  1: 74.0,
  3: 74.2,
  7: 74.4,
  11: 74.6,
  14: 74.8,
};

// Workouts on specific days
const WORKOUTS: Array<{
  day: number;
  type: string;
  duration_s: number;
  distance_m?: number;
  calories?: number;
}> = [
  { day: 1,  type: 'run', duration_s: 33 * 60,  distance_m: 6_000,  calories: 420 },
  { day: 3,  type: 'run', duration_s: 55 * 60,  distance_m: 10_000, calories: 700 },
  { day: 6,  type: 'gym', duration_s: 60 * 60,                       calories: 380 },
  { day: 9,  type: 'run', duration_s: 44 * 60,  distance_m: 8_000,  calories: 560 },
  { day: 12, type: 'run', duration_s: 28 * 60,  distance_m: 5_000,  calories: 350 },
];

// Meals on specific days: hour is CDT (UTC-5), converted +5 to UTC on insert
const MEALS: Array<{
  day: number;
  hour: number;
  description: string;
  kcal: number;
  c: number;
  p: number;
  f: number;
}> = [
  // Day -1
  { day: 1, hour: 8,  description: 'Oat porridge with banana and almond butter',            kcal: 420, c: 58, p: 14, f: 14 },
  { day: 1, hour: 13, description: 'Grilled chicken salad with feta and olive oil',          kcal: 510, c: 18, p: 42, f: 26 },
  { day: 1, hour: 19, description: 'Salmon with roasted sweet potato and broccoli',          kcal: 620, c: 48, p: 45, f: 18 },
  // Day -3
  { day: 3, hour: 9,  description: 'Greek yogurt with berries and granola',                  kcal: 380, c: 52, p: 18, f:  9 },
  { day: 3, hour: 14, description: 'Turkey wrap with avocado',                               kcal: 540, c: 42, p: 36, f: 20 },
  { day: 3, hour: 19, description: 'Beef stir fry with rice and vegetables',                 kcal: 680, c: 72, p: 38, f: 16 },
  // Day -6
  { day: 6, hour: 8,  description: 'Oat milk latte and two boiled eggs on toast',            kcal: 390, c: 36, p: 18, f: 16 },
  { day: 6, hour: 19, description: 'Pasta with marinara and ground beef',                    kcal: 720, c: 88, p: 34, f: 18 },
  // Day -9
  { day: 9, hour: 9,  description: 'Smoothie with oat milk, banana, protein powder, PB',    kcal: 460, c: 54, p: 32, f: 14 },
  { day: 9, hour: 13, description: 'Brown rice bowl with tofu and edamame',                  kcal: 520, c: 68, p: 28, f: 12 },
  // Day -12
  { day: 12, hour: 8,  description: 'Scrambled eggs with avocado toast',                    kcal: 490, c: 32, p: 22, f: 26 },
  { day: 12, hour: 13, description: 'Chicken pho with rice noodles',                        kcal: 560, c: 64, p: 38, f: 10 },
  { day: 12, hour: 19, description: 'Pork tenderloin with mashed potato and green beans',   kcal: 590, c: 44, p: 46, f: 14 },
];

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Load .env.local BEFORE importing db (static imports are hoisted in ESM,
  // so we use dynamic imports here to control evaluation order).
  const { config } = await import('dotenv');
  config({ path: process.cwd() + '/.env.local' });

  const { db, schema } = await import('../db');
  const { getOrCreateDevUser } = await import('../lib/brain/user');
  const { eq, and, sql } = await import('drizzle-orm');

  const userId = await getOrCreateDevUser();
  console.log(`Dev user UUID: ${userId}`);

  // ── Purge prior seeded rows ────────────────────────────────────────────────
  const deletedEvents = await db
    .delete(schema.events)
    .where(
      and(
        eq(schema.events.user_id, userId),
        sql`(${schema.events.payload}->>'seed')::text = 'true'`,
      ),
    )
    .returning({ id: schema.events.id });

  const deletedFacts = await db
    .delete(schema.pending_facts)
    .where(
      and(
        eq(schema.pending_facts.user_id, userId),
        sql`${schema.pending_facts.evidence} LIKE '[seed]%'`,
      ),
    )
    .returning({ id: schema.pending_facts.id });

  console.log(`Purged ${deletedEvents.length} prior seeded events, ${deletedFacts.length} prior pending_facts.`);

  // ── Build timestamp helper ─────────────────────────────────────────────────
  const todayMidnightUTC = new Date();
  todayMidnightUTC.setUTCHours(0, 0, 0, 0);

  /** Returns a Date that is `daysBack` UTC days before today at utcHour:utcMin. */
  const at = (daysBack: number, utcHour: number, utcMin = 0): Date => {
    const d = new Date(todayMidnightUTC);
    d.setUTCDate(d.getUTCDate() - daysBack);
    d.setUTCHours(utcHour, utcMin, 0, 0);
    return d;
  };

  // ── Build events array ─────────────────────────────────────────────────────
  const eventsToInsert: Array<typeof schema.events.$inferInsert> = [];

  for (let d = 1; d <= 14; d++) {
    // HRV reading — 07:30 UTC (morning, on wake-up)
    eventsToInsert.push({
      user_id:   userId,
      timestamp: at(d, 7, 30),
      type:      'hrv_reading',
      payload:   { value: HRV_VALUES[d - 1], unit: 'ms', seed: true },
      source:    'healthkit',
    });

    // Sleep session — 07:00 UTC (morning log, end of sleep)
    const [durMs, efficiency, rhr] = SLEEP_DATA[d - 1];
    eventsToInsert.push({
      user_id:   userId,
      timestamp: at(d, 7, 0),
      type:      'sleep_session',
      payload:   { duration_ms: durMs, efficiency, rhr, seed: true },
      source:    'healthkit',
    });

    // Steps — 22:00 UTC (end-of-day cumulative total)
    eventsToInsert.push({
      user_id:   userId,
      timestamp: at(d, 22, 0),
      type:      'steps_recorded',
      payload:   { count: STEPS_VALUES[d - 1], seed: true },
      source:    'healthkit',
    });

    // Weight — 08:00 UTC (only on specific days)
    if (WEIGHT_DAYS[d] != null) {
      eventsToInsert.push({
        user_id:   userId,
        timestamp: at(d, 8, 0),
        type:      'weight_logged',
        payload:   { value: WEIGHT_DAYS[d], unit: 'kg', seed: true },
        source:    'healthkit',
      });
    }
  }

  // Workouts — 17:00 UTC (noon CDT)
  for (const w of WORKOUTS) {
    eventsToInsert.push({
      user_id:   userId,
      timestamp: at(w.day, 17, 0),
      type:      'workout_completed',
      payload: {
        type:       w.type,
        duration_s: w.duration_s,
        ...(w.distance_m != null && { distance_m: w.distance_m }),
        ...(w.calories   != null && { calories:   w.calories }),
        seed: true,
      },
      source: 'healthkit',
    });
  }

  // Meals — CDT hours +5 → UTC
  for (const m of MEALS) {
    eventsToInsert.push({
      user_id:   userId,
      timestamp: at(m.day, m.hour + 5, 0),
      type:      'meal_logged',
      payload:   { kcal: m.kcal, c: m.c, p: m.p, f: m.f, description: m.description, seed: true },
      source:    'coach',
    });
  }

  await db.insert(schema.events).values(eventsToInsert);
  console.log(`Inserted ${eventsToInsert.length} events.`);

  // ── Pending facts ─────────────────────────────────────────────────────────
  const factsToInsert: Array<typeof schema.pending_facts.$inferInsert> = [
    {
      user_id:       userId,
      proposed_node: { type: 'FoodPreference', label: 'prefers oat milk', properties: {} },
      proposed_edge: null,
      evidence:      '[seed] User mentioned they use oat milk in their morning coffee instead of dairy milk.',
      salience:      0.7,
      status:        'pending',
    },
    {
      user_id:       userId,
      proposed_node: { type: 'Goal', label: 'lose 2kg by end of August', properties: {} },
      proposed_edge: null,
      evidence:      '[seed] User said they want to drop a couple of kilos before the end of summer.',
      salience:      0.85,
      status:        'pending',
    },
  ];

  await db.insert(schema.pending_facts).values(factsToInsert);
  console.log(`Inserted ${factsToInsert.length} pending_facts.`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const [eventRows, factRows] = await Promise.all([
    db
      .select({ type: schema.events.type })
      .from(schema.events)
      .where(eq(schema.events.user_id, userId)),
    db
      .select({ status: schema.pending_facts.status })
      .from(schema.pending_facts)
      .where(eq(schema.pending_facts.user_id, userId)),
  ]);

  const typeCounts: Record<string, number> = {};
  for (const { type } of eventRows) typeCounts[type] = (typeCounts[type] ?? 0) + 1;

  console.log('\nTotal events for dev user:');
  for (const [type, count] of Object.entries(typeCounts).sort()) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  TOTAL: ${eventRows.length}`);
  console.log(`\nPending facts: ${factRows.filter(f => f.status === 'pending').length}`);
  console.log('\nSeed complete.');

  process.exit(0);
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
