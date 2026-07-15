import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';

import { buildQualifyingStreakDaysQuery, fetchQualifyingStreakDays } from './streakRepository';

test('qualifying-day query deduplicates in PostgreSQL and returns only local day keys', () => {
  const query = new PgDialect().sqlToQuery(
    buildQualifyingStreakDaysQuery('user-123', 'America/Chicago'),
  );

  assert.match(query.sql, /^select distinct day from \(/i);
  assert.match(query.sql, /at time zone \$\d+/i);
  assert.match(query.sql, /"events"/);
  assert.match(query.sql, /"daily_metrics"/);
  assert.match(query.sql, /"messages"/);
  assert.match(query.sql, /"plan_items"/);
  assert.match(query.sql, /"metric" = \$\d+.*"value" > 0/is);
  assert.match(query.sql, /"role" = \$\d+/i);
  assert.match(query.sql, /"status" = \$\d+/i);
  assert.doesNotMatch(query.sql, /select \*/i);
  assert.doesNotMatch(query.sql, /meal_logged|workout_completed|'workouts'|'user'|'done'/i);
  assert.ok(query.params.includes('America/Chicago'));
  for (const filter of ['meal_logged', 'workout_completed', 'workouts', 'user', 'done']) {
    assert.ok(query.params.includes(filter));
  }
  assert.ok(query.params.filter(value => value === 'user-123').length >= 4);
});

test('repository exposes only distinct day strings returned by the database', async () => {
  let executions = 0;
  const executor = {
    execute: async () => {
      executions += 1;
      return [{ day: '2026-07-14' }, { day: '2026-07-13' }];
    },
  };

  const days = await fetchQualifyingStreakDays(executor, 'user-123', 'UTC');

  assert.equal(executions, 1);
  assert.deepEqual(days, new Set(['2026-07-14', '2026-07-13']));
});
