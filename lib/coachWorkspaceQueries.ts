import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { coach_recommendation_interactions } from '@/db/schema';

function currentMaterialOccurrence(
  userId: string,
  recommendationId: string,
  materialSignature: string,
) {
  return sql`(
    (
      ${coach_recommendation_interactions.adjustment}->>'__materialSignature' = ${materialSignature}
      and ${coach_recommendation_interactions.occurrence_seq} > coalesce((
        select max(boundary.occurrence_seq)
        from coach_recommendation_interactions boundary
        where boundary.user_id = ${userId}
          and boundary.recommendation_id = ${recommendationId}
          and boundary.adjustment->>'__materialSignature' is distinct from ${materialSignature}
      ), 0)
    )
    or (
      ${coach_recommendation_interactions.adjustment}->>'__materialSignature' is null
      and not exists (
        select 1
        from coach_recommendation_interactions signed
        where signed.user_id = ${userId}
          and signed.recommendation_id = ${recommendationId}
          and signed.adjustment->>'__materialSignature' is not null
      )
    )
  )`;
}

/** SQL predicate excludes chat and prior material occurrences before LIMIT. */
export function latestCurrentStatefulPredicate(
  userId: string,
  recommendationId: string,
  materialSignature: string,
) {
  const predicate = and(
    eq(coach_recommendation_interactions.user_id, userId),
    eq(coach_recommendation_interactions.recommendation_id, recommendationId),
    ne(coach_recommendation_interactions.action, 'open_chat'),
    currentMaterialOccurrence(userId, recommendationId, materialSignature),
  );
  if (!predicate) throw new Error('Unable to build current stateful interaction predicate.');
  return predicate;
}

/** SQL predicate excludes unlinked and prior-occurrence rows before LIMIT. */
export function latestCurrentLinkedPlanPredicate(
  userId: string,
  recommendationId: string,
  materialSignature: string,
) {
  const predicate = and(
    latestCurrentStatefulPredicate(userId, recommendationId, materialSignature),
    isNotNull(coach_recommendation_interactions.plan_item_id),
  );
  if (!predicate) throw new Error('Unable to build current linked-plan predicate.');
  return predicate;
}
