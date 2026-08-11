import { and, eq, ne } from 'drizzle-orm';
import { coach_recommendation_interactions } from '@/db/schema';

/** SQL predicate intentionally excludes chat-only rows before ORDER/LIMIT. */
export function hydrationInteractionPredicate(userId: string, recommendationId: string) {
  const predicate = and(
    eq(coach_recommendation_interactions.user_id, userId),
    eq(coach_recommendation_interactions.recommendation_id, recommendationId),
    ne(coach_recommendation_interactions.action, 'open_chat'),
  );
  if (!predicate) throw new Error('Unable to build hydration interaction predicate.');
  return predicate;
}
