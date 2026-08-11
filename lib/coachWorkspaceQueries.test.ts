import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  linkedPlanPredicateForAction,
  latestLinkedPlanPredicate,
  latestCurrentLinkedPlanPredicate,
  latestCurrentStatefulPredicate,
} from './coachWorkspaceQueries';

test('more than 50 chat rows cannot hide state because SQL filters them before limit', () => {
  const query = new PgDialect().sqlToQuery(
    latestCurrentStatefulPredicate('user-1', 'recommendation-1', 'signature-a').getSQL(),
  );

  assert.match(query.sql, /"action" <> \$\d+/);
  assert.match(query.sql, /"occurrence_seq" > coalesce/);
  assert.match(query.sql, /max\(boundary\.occurrence_seq\)/);
  assert.match(query.sql, /__materialSignature/);
  assert.ok(query.params.includes('open_chat'));
  assert.ok(query.params.includes('signature-a'));
});

test('Accept, Adjust, and Skip reuse the latest linked plan across material occurrences', () => {
  for (const action of ['accept', 'adjust', 'skip'] as const) {
    const query = new PgDialect().sqlToQuery(
      linkedPlanPredicateForAction(action, 'user-1', 'recommendation-1', 'signature-b').getSQL(),
    );
    assert.match(query.sql, /"plan_item_id" is not null/i);
    assert.doesNotMatch(query.sql, /__materialSignature/);
  }

  const latest = new PgDialect().sqlToQuery(
    latestLinkedPlanPredicate('user-1', 'recommendation-1').getSQL(),
  );
  assert.match(latest.sql, /"plan_item_id" is not null/i);
});

test('Complete remains scoped to a linked plan in the current material occurrence', () => {
  const query = new PgDialect().sqlToQuery(
    linkedPlanPredicateForAction('complete', 'user-1', 'recommendation-1', 'signature-b').getSQL(),
  );

  assert.match(query.sql, /"plan_item_id" is not null/i);
  assert.match(query.sql, /__materialSignature/);
  assert.match(query.sql, /"occurrence_seq" > coalesce/);
});

test('current-occurrence plan reuse survives more than 50 unlinked rows because SQL filters before limit', () => {
  const query = new PgDialect().sqlToQuery(
    latestCurrentLinkedPlanPredicate('user-1', 'recommendation-1', 'signature-a').getSQL(),
  );

  assert.match(query.sql, /"plan_item_id" is not null/i);
  assert.match(query.sql, /not exists/i);
  assert.match(query.sql, /__materialSignature/);
});
