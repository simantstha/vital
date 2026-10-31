/**
 * Vital — injury check-in loader
 *
 * DB-facing wrapper around the pure picker (lib/injuryCheckIn.ts). Reads the user's Injury facts from the same
 * `nodes` the chat coach builds its NEVER VIOLATE block from (lib/brain/context.ts: type 'Injury' is one of
 * HARD_CONSTRAINT_TYPES; status 'active', not superseded, subject_node_id NULL = about the user themself), so a fact the
 * coach honours and a fact the plan surfaces ask about can never disagree. No scoring logic lives here.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { localDayKey } from '@/lib/localDay';
import { pickInjuryCheckIn, type InjuryCheckIn } from '@/lib/injuryCheckIn';

/** nodes.type of an injury fact (db/schema.ts' node types; also in lib/brain/context.ts HARD_CONSTRAINT_TYPES). */
const INJURY_NODE_TYPE = 'Injury';
/** More than enough rows: only injuries logged in the last 28 days can win, and a user rarely has more than a few. */
const MAX_ROWS = 20;

/**
 * The user's most recent active injury within the check-in window as of the local day `todayKey` (`tz` is the zone the
 * logged day is read in), or null. Never throws: the injury line is an extra on the goal card, so a failed lookup means the card
 * carries no injury line — it must never fail the card (or the review, or the brief) around it.
 */
export async function loadActiveInjury(userId: string, todayKey: string, tz: string): Promise<InjuryCheckIn | null> {
  try {
    const rows = await db
      .select({
        label: schema.nodes.label,
        status: schema.nodes.status,
        superseded_by: schema.nodes.superseded_by,
        subject_node_id: schema.nodes.subject_node_id,
        created_at: schema.nodes.created_at,
      })
      .from(schema.nodes)
      .where(
        and(
          eq(schema.nodes.user_id, userId),
          eq(schema.nodes.type, INJURY_NODE_TYPE),
          eq(schema.nodes.status, 'active'),
          isNull(schema.nodes.superseded_by),
          isNull(schema.nodes.subject_node_id),
        ),
      )
      .orderBy(desc(schema.nodes.created_at))
      .limit(MAX_ROWS);

    // (The query already filters; the same three tests here keep a resolved, replaced or third-party fact out even if the
    // rows ever arrive some other way.)
    return pickInjuryCheckIn(
      rows
        .filter(r => r.status === 'active' && r.superseded_by == null && r.subject_node_id == null)
        .map(r => ({ label: r.label, loggedDay: localDayKey(r.created_at, tz) })),
      todayKey,
    );
  } catch (err) {
    console.error(`[injuryCheckIn] lookup failed for user ${userId}; the card carries no injury line:`, err);
    return null;
  }
}
