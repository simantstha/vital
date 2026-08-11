import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { hydrationInteractionPredicate } from './coachWorkspaceQueries';

test('hydration SQL excludes open_chat before the repository applies its limit', () => {
  const query = new PgDialect().sqlToQuery(
    hydrationInteractionPredicate('user-1', 'recommendation-1').getSQL(),
  );

  assert.match(query.sql, /"action" <> \$\d+/);
  assert.ok(query.params.includes('open_chat'));
});
