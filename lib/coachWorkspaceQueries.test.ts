import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
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

test('current-occurrence plan reuse survives more than 50 unlinked rows because SQL filters before limit', () => {
  const query = new PgDialect().sqlToQuery(
    latestCurrentLinkedPlanPredicate('user-1', 'recommendation-1', 'signature-a').getSQL(),
  );

  assert.match(query.sql, /"plan_item_id" is not null/i);
  assert.match(query.sql, /not exists/i);
  assert.match(query.sql, /__materialSignature/);
});
