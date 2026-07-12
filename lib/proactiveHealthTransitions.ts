export const MAX_DELIVERY_RETRIES = 5;

export interface RetryTransition { retryCount: number; terminal: boolean; nextAttemptAt: Date }
export function retryTransition(retryCount: number, now: Date, maxRetries = MAX_DELIVERY_RETRIES): RetryTransition {
  const next = retryCount + 1;
  return { retryCount: next, terminal: next >= maxRetries, nextAttemptAt: new Date(now.getTime() + Math.min(360, 2 ** retryCount) * 60_000) };
}

export function ownsLease(actual: string | null, expected: string): boolean { return actual === expected; }
export function notificationClaimable(state: string, leaseExpiresAt: Date | null, nextAttemptAt: Date, now: Date): boolean {
  return nextAttemptAt <= now && (state === 'pending' || (state === 'sending' && leaseExpiresAt !== null && leaseExpiresAt <= now));
}

export interface DueCandidate { overdueMinutes: number; updatedAt: Date }
export function compareDueCandidates(a: DueCandidate, b: DueCandidate): number {
  return b.overdueMinutes - a.overdueMinutes || a.updatedAt.getTime() - b.updatedAt.getTime();
}

export interface MorningClaimAdapter<T> {
  tryInsert(actor: 'sleep' | 'brief'): Promise<T | null>;
  tryRecover(actor: 'sleep' | 'brief'): Promise<T | null>;
}
export async function claimMorningSlot<T>(adapter: MorningClaimAdapter<T>, actor: 'sleep' | 'brief'): Promise<T | null> {
  return await adapter.tryInsert(actor) ?? adapter.tryRecover(actor);
}

export interface MorningFailureAdapter { apply(ownerToken: string, transition: RetryTransition): Promise<boolean> }
export async function failOwnedMorningSlot(adapter: MorningFailureAdapter, ownerToken: string, retryCount: number, now: Date): Promise<boolean> {
  return adapter.apply(ownerToken, retryTransition(retryCount, now));
}
