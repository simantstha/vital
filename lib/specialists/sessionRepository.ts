import { and, eq, inArray, lte } from 'drizzle-orm';
import { db, schema } from '@/db';
import {
  OPEN_SPECIALIST_SESSION_STATUSES,
  PENDING_SPECIALIST_SESSION_STATUSES,
  OpenSpecialistSessionExistsError,
  type SpecialistSession,
  type SpecialistSessionRepository,
  type SpecialistSessionStatus,
} from './sessions';

type StoredSpecialistSession = typeof schema.specialist_sessions.$inferSelect;

function fromStored(row: StoredSpecialistSession): SpecialistSession {
  return {
    id: row.id,
    userId: row.user_id,
    objective: row.objective,
    manifestId: row.manifest_id,
    manifestVersion: row.manifest_version,
    status: row.status as SpecialistSessionStatus,
    inboundHandoff: row.inbound_handoff,
    returnHandoff: row.return_handoff,
    failureReason: row.failure_reason,
    proposedAt: row.proposed_at,
    activatedAt: row.activated_at,
    returnProposedAt: row.return_proposed_at,
    completedAt: row.completed_at,
    declinedAt: row.declined_at,
    failedAt: row.failed_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

function toStored(session: SpecialistSession): typeof schema.specialist_sessions.$inferInsert {
  return {
    id: session.id,
    user_id: session.userId,
    objective: session.objective,
    manifest_id: session.manifestId,
    manifest_version: session.manifestVersion,
    status: session.status,
    inbound_handoff: session.inboundHandoff,
    return_handoff: session.returnHandoff,
    failure_reason: session.failureReason,
    proposed_at: session.proposedAt,
    activated_at: session.activatedAt,
    return_proposed_at: session.returnProposedAt,
    completed_at: session.completedAt,
    declined_at: session.declinedAt,
    failed_at: session.failedAt,
    expires_at: session.expiresAt,
    updated_at: session.updatedAt,
  };
}

export class DrizzleSpecialistSessionRepository implements SpecialistSessionRepository {
  async findByUserAndId(userId: string, id: string): Promise<SpecialistSession | null> {
    const [row] = await db.select()
      .from(schema.specialist_sessions)
      .where(and(
        eq(schema.specialist_sessions.user_id, userId),
        eq(schema.specialist_sessions.id, id),
      ))
      .limit(1);
    return row ? fromStored(row) : null;
  }

  async findOpenByUser(userId: string): Promise<SpecialistSession | null> {
    const [row] = await db.select()
      .from(schema.specialist_sessions)
      .where(and(
        eq(schema.specialist_sessions.user_id, userId),
        inArray(schema.specialist_sessions.status, [...OPEN_SPECIALIST_SESSION_STATUSES]),
      ))
      .limit(1);
    return row ? fromStored(row) : null;
  }

  async insert(session: SpecialistSession): Promise<SpecialistSession> {
    try {
      const [row] = await db.insert(schema.specialist_sessions)
        .values(toStored(session))
        .returning();
      return fromStored(row);
    } catch (error) {
      if (isOneOpenSessionViolation(error)) {
        throw new OpenSpecialistSessionExistsError(
          `User ${session.userId} already has an open specialist session`,
        );
      }
      throw error;
    }
  }

  async update(session: SpecialistSession): Promise<SpecialistSession> {
    const [row] = await db.update(schema.specialist_sessions)
      .set(toStored(session))
      .where(and(
        eq(schema.specialist_sessions.user_id, session.userId),
        eq(schema.specialist_sessions.id, session.id),
      ))
      .returning();
    if (!row) throw new Error(`Specialist session ${session.id} no longer exists`);
    return fromStored(row);
  }

  async findExpiredPending(now: Date): Promise<SpecialistSession[]> {
    const rows = await db.select()
      .from(schema.specialist_sessions)
      .where(and(
        inArray(schema.specialist_sessions.status, [...PENDING_SPECIALIST_SESSION_STATUSES]),
        lte(schema.specialist_sessions.expires_at, now),
      ));
    return rows.map(fromStored);
  }
}

function isOneOpenSessionViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'constraint_name' in error &&
    error.constraint_name === 'specialist_sessions_one_open_per_user_idx';
}
