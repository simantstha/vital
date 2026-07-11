import { randomUUID } from 'node:crypto';

export type SpecialistSessionStatus =
  | 'proposed'
  | 'active'
  | 'return_proposed'
  | 'completed'
  | 'declined'
  | 'failed';

export const OPEN_SPECIALIST_SESSION_STATUSES: readonly SpecialistSessionStatus[] = [
  'proposed',
  'active',
  'return_proposed',
];

export const PENDING_SPECIALIST_SESSION_STATUSES: readonly SpecialistSessionStatus[] = [
  'proposed',
  'return_proposed',
];

export const VALID_SPECIALIST_SESSION_TRANSITIONS: Readonly<
  Record<SpecialistSessionStatus, readonly SpecialistSessionStatus[]>
> = {
  proposed: ['active', 'declined', 'failed'],
  active: ['return_proposed', 'failed'],
  return_proposed: ['active', 'completed', 'failed'],
  completed: [],
  declined: [],
  failed: [],
};

export interface SpecialistSession {
  id: string;
  userId: string;
  objective: string;
  manifestId: string;
  manifestVersion: string;
  status: SpecialistSessionStatus;
  inboundHandoff: unknown;
  returnHandoff: unknown | null;
  failureReason: string | null;
  proposedAt: Date;
  activatedAt: Date | null;
  returnProposedAt: Date | null;
  completedAt: Date | null;
  declinedAt: Date | null;
  failedAt: Date | null;
  expiresAt: Date | null;
  updatedAt: Date;
}

export interface ProposeSpecialistSessionInput {
  userId: string;
  objective: string;
  manifestId: string;
  manifestVersion: string;
  inboundHandoff: unknown;
  expiresAt: Date;
}

export interface SpecialistSessionTransitionDetails {
  returnHandoff?: unknown;
  failureReason?: string;
  expiresAt?: Date;
}

export interface SpecialistMessageAttributionInput {
  sessionId: string;
  specialistId: string;
  manifestVersion: string;
  name: string;
  role: string;
  accentColor: string;
  icon: string;
}

export interface SpecialistMessageAttribution {
  speaker: 'specialist';
  specialistSessionId: string;
  specialistMetadata: Omit<SpecialistMessageAttributionInput, 'sessionId'>;
}

export interface SpecialistSessionRepository {
  findByUserAndId(userId: string, id: string): Promise<SpecialistSession | null>;
  findOpenByUser(userId: string): Promise<SpecialistSession | null>;
  insert(session: SpecialistSession): Promise<SpecialistSession>;
  update(
    session: SpecialistSession,
    expectedStatus: SpecialistSessionStatus,
  ): Promise<SpecialistSession>;
  findExpiredPending(now: Date): Promise<SpecialistSession[]>;
}

export class InvalidSpecialistSessionTransitionError extends Error {}
export class OpenSpecialistSessionExistsError extends Error {}
export class ProposalExpiryRequiredError extends Error {}
export class ConcurrentSpecialistSessionUpdateError extends Error {}

export class InMemorySpecialistSessionRepository implements SpecialistSessionRepository {
  private readonly rows = new Map<string, SpecialistSession>();

  async findByUserAndId(userId: string, id: string): Promise<SpecialistSession | null> {
    const row = this.rows.get(id);
    return row?.userId === userId ? structuredClone(row) : null;
  }

  async findOpenByUser(userId: string): Promise<SpecialistSession | null> {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.userId === userId && OPEN_SPECIALIST_SESSION_STATUSES.includes(candidate.status),
    );
    return row ? structuredClone(row) : null;
  }

  async insert(session: SpecialistSession): Promise<SpecialistSession> {
    if (OPEN_SPECIALIST_SESSION_STATUSES.includes(session.status) && await this.findOpenByUser(session.userId)) {
      throw new OpenSpecialistSessionExistsError(`User ${session.userId} already has an open specialist session`);
    }
    this.rows.set(session.id, structuredClone(session));
    return structuredClone(session);
  }

  async update(
    session: SpecialistSession,
    expectedStatus: SpecialistSessionStatus,
  ): Promise<SpecialistSession> {
    const stored = this.rows.get(session.id);
    if (!stored || stored.userId !== session.userId || stored.status !== expectedStatus) {
      throw new ConcurrentSpecialistSessionUpdateError(
        `Specialist session ${session.id} changed before the update could be applied`,
      );
    }
    this.rows.set(session.id, structuredClone(session));
    return structuredClone(session);
  }

  async findExpiredPending(now: Date): Promise<SpecialistSession[]> {
    return [...this.rows.values()]
      .filter((row) =>
        PENDING_SPECIALIST_SESSION_STATUSES.includes(row.status) &&
        row.expiresAt !== null &&
        row.expiresAt <= now,
      )
      .map((row) => structuredClone(row));
  }
}

export class SpecialistSessionService<R extends SpecialistSessionRepository = SpecialistSessionRepository> {
  constructor(
    readonly repository: R,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async propose(input: ProposeSpecialistSessionInput): Promise<SpecialistSession> {
    if (await this.repository.findOpenByUser(input.userId)) {
      throw new OpenSpecialistSessionExistsError(
        `User ${input.userId} already has an open specialist session`,
      );
    }
    const now = this.now();
    return this.repository.insert({
      id: randomUUID(),
      ...input,
      status: 'proposed',
      returnHandoff: null,
      failureReason: null,
      proposedAt: now,
      activatedAt: null,
      returnProposedAt: null,
      completedAt: null,
      declinedAt: null,
      failedAt: null,
      updatedAt: now,
    });
  }

  get(userId: string, id: string): Promise<SpecialistSession | null> {
    return this.repository.findByUserAndId(userId, id);
  }

  async transition(
    userId: string,
    id: string,
    to: SpecialistSessionStatus,
    details: SpecialistSessionTransitionDetails = {},
  ): Promise<SpecialistSession> {
    const current = await this.repository.findByUserAndId(userId, id);
    if (!current) throw new Error(`Specialist session ${id} not found for user ${userId}`);
    if (!VALID_SPECIALIST_SESSION_TRANSITIONS[current.status].includes(to)) {
      throw new InvalidSpecialistSessionTransitionError(
        `Cannot transition specialist session from ${current.status} to ${to}`,
      );
    }

    const now = this.now();
    if (to === 'return_proposed' &&
      (!details.expiresAt || details.expiresAt <= now)) {
      throw new ProposalExpiryRequiredError(
        'A return proposal requires an expiry later than the current time',
      );
    }
    const next: SpecialistSession = {
      ...current,
      status: to,
      updatedAt: now,
      expiresAt: PENDING_SPECIALIST_SESSION_STATUSES.includes(to)
        ? details.expiresAt ?? current.expiresAt
        : null,
    };
    if (to === 'active') next.activatedAt ??= now;
    if (to === 'return_proposed') {
      next.returnProposedAt = now;
      next.returnHandoff = details.returnHandoff ?? null;
    }
    if (to === 'completed') next.completedAt = now;
    if (to === 'declined') next.declinedAt = now;
    if (to === 'failed') {
      next.failedAt = now;
      next.failureReason = details.failureReason ?? 'session_failed';
    }
    return this.repository.update(next, current.status);
  }

  async expirePendingProposals(): Promise<SpecialistSession[]> {
    const now = this.now();
    const expired = await this.repository.findExpiredPending(now);
    const results = await Promise.all(expired.map(async (session) => {
      try {
        return await this.repository.update({
          ...session,
          status: 'failed',
          failureReason: 'proposal_expired',
          failedAt: now,
          expiresAt: null,
          updatedAt: now,
        }, session.status);
      } catch (error) {
        if (error instanceof ConcurrentSpecialistSessionUpdateError) return null;
        throw error;
      }
    }));
    return results.filter((session): session is SpecialistSession => session !== null);
  }

  messageAttribution(input: SpecialistMessageAttributionInput): SpecialistMessageAttribution {
    const { sessionId, ...specialistMetadata } = input;
    return {
      speaker: 'specialist',
      specialistSessionId: sessionId,
      specialistMetadata,
    };
  }
}
