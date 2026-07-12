import { randomUUID } from 'node:crypto';
import { specialistRegistry } from './registry';

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
  active: ['return_proposed', 'completed', 'failed'],
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
  cardOccurrenceId: string;
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
  specialist_session_id: string;
  specialist_metadata: Omit<SpecialistMessageAttributionInput, 'sessionId'>;
}

export interface SpecialistManifestCatalog {
  get(id: string): { version: string };
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
    private readonly manifests: SpecialistManifestCatalog = specialistRegistry,
  ) {}

  async propose(input: ProposeSpecialistSessionInput): Promise<SpecialistSession> {
    const manifest = this.manifests.get(input.manifestId);
    if (manifest.version !== input.manifestVersion) {
      throw new Error(
        `Specialist manifest version ${input.manifestVersion} does not match registered version ${manifest.version}`,
      );
    }
    if (await this.findOpen(input.userId)) {
      throw new OpenSpecialistSessionExistsError(
        `User ${input.userId} already has an open specialist session`,
      );
    }
    const now = this.now();
    return this.repository.insert({
      id: randomUUID(),
      ...input,
      status: 'proposed',
      cardOccurrenceId: randomUUID(),
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

  async get(userId: string, id: string): Promise<SpecialistSession | null> {
    const session = await this.repository.findByUserAndId(userId, id);
    return session ? this.reconcileExpiry(session) : null;
  }

  async findOpen(userId: string): Promise<SpecialistSession | null> {
    const session = await this.repository.findOpenByUser(userId);
    if (!session) return null;
    const reconciled = await this.reconcileExpiry(session);
    return reconciled && OPEN_SPECIALIST_SESSION_STATUSES.includes(reconciled.status)
      ? reconciled
      : null;
  }

  async disableOpen(userId: string): Promise<SpecialistSession | null> {
    const session = await this.repository.findOpenByUser(userId);
    if (!session) return null;
    try {
      return await this.transition(userId, session.id, 'failed', {
        failureReason: 'specialists_disabled',
      });
    } catch (error) {
      if (!(error instanceof ConcurrentSpecialistSessionUpdateError)) throw error;
      return this.repository.findByUserAndId(userId, session.id);
    }
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
      next.cardOccurrenceId = randomUUID();
      next.returnProposedAt = now;
      next.returnHandoff = details.returnHandoff ?? null;
    }
    if (to === 'completed') {
      next.completedAt = now;
      if (details.returnHandoff !== undefined) next.returnHandoff = details.returnHandoff;
    }
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
        return await this.reconcileExpiry(session, false);
      } catch (error) {
        if (error instanceof ConcurrentSpecialistSessionUpdateError) return null;
        throw error;
      }
    }));
    return results.filter((session): session is SpecialistSession => session !== null);
  }

  private async reconcileExpiry(
    session: SpecialistSession,
    returnConcurrentState = true,
  ): Promise<SpecialistSession | null> {
    const now = this.now();
    if (!PENDING_SPECIALIST_SESSION_STATUSES.includes(session.status) ||
      session.expiresAt === null || session.expiresAt > now) {
      return session;
    }
    const next: SpecialistSession = session.status === 'proposed'
      ? {
          ...session,
          status: 'failed',
          failureReason: 'proposal_expired',
          failedAt: now,
          expiresAt: null,
          updatedAt: now,
        }
      : {
          ...session,
          status: 'active',
          expiresAt: null,
          updatedAt: now,
        };
    try {
      return await this.repository.update(next, session.status);
    } catch (error) {
      if (!(error instanceof ConcurrentSpecialistSessionUpdateError)) throw error;
      if (!returnConcurrentState) return null;
      const current = await this.repository.findByUserAndId(session.userId, session.id);
      if (!current) throw error;
      return current;
    }
  }

  messageAttribution(input: SpecialistMessageAttributionInput): SpecialistMessageAttribution {
    const { sessionId, ...specialistMetadata } = input;
    return {
      speaker: 'specialist',
      specialist_session_id: sessionId,
      specialist_metadata: specialistMetadata,
    };
  }
}
