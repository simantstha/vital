import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../../db/schema';

/**
 * memoryTiers.ts formalizes provisional ('coach') / consolidated ('digest') /
 * user-confirmed ('confirmed') facts. Pure logic — no DB needed for
 * assertDigestMutable/rankSource — but sourcePrecedenceSql builds a Drizzle
 * SQL fragment, so `@/db` is mocked first per this repo's DB-free test style
 * (see lib/proactiveHealthWorkerRepository.test.ts) even though this module
 * never imports `@/db` itself; the mock just keeps the pattern consistent
 * for anything imported alongside it in a shared test file.
 */
mock.module('@/db', { namedExports: { db: {}, schema: realSchema } });

test('assertDigestMutable throws for a user-confirmed node (source: confirmed)', async () => {
  const { assertDigestMutable } = await import('./memoryTiers');
  assert.throws(() => assertDigestMutable({ source: 'confirmed', properties: null }));
});

test('assertDigestMutable throws for a node carrying confirmed_by: user in properties, regardless of source', async () => {
  const { assertDigestMutable } = await import('./memoryTiers');
  assert.throws(() => assertDigestMutable({ source: 'digest', properties: { confirmed_by: 'user' } }));
});

test('assertDigestMutable permits coach-sourced (provisional) nodes', async () => {
  const { assertDigestMutable } = await import('./memoryTiers');
  assert.doesNotThrow(() => assertDigestMutable({ source: 'coach', properties: { evidence: 'goes for runs' } }));
});

test('assertDigestMutable permits digest-sourced (consolidated) nodes without user confirmation', async () => {
  const { assertDigestMutable } = await import('./memoryTiers');
  assert.doesNotThrow(() => assertDigestMutable({ source: 'digest', properties: null }));
});

test('rankSource orders confirmed > digest > coach, and ranks unknown sources last', async () => {
  const { rankSource } = await import('./memoryTiers');
  const ranked = ['coach', 'unknown-source', 'confirmed', 'digest']
    .map((source) => ({ source, rank: rankSource(source) }))
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.source);

  assert.deepEqual(ranked, ['confirmed', 'digest', 'coach', 'unknown-source']);
});

test('SOURCE_PRECEDENCE ranks are strictly ordered confirmed > digest > coach', async () => {
  const { SOURCE_PRECEDENCE } = await import('./memoryTiers');
  assert.ok(SOURCE_PRECEDENCE.confirmed > SOURCE_PRECEDENCE.digest);
  assert.ok(SOURCE_PRECEDENCE.digest > SOURCE_PRECEDENCE.coach);
});

/**
 * THE DRIFT GUARD. sourcePrecedenceSql() generates its CASE arms from
 * SOURCE_PRECEDENCE, and rankSource() reads the same object — but only this
 * test proves the *rendered SQL* actually agrees with rankSource() for every
 * declared source. If someone re-hardcodes the CASE, adds a tier to
 * SOURCE_PRECEDENCE that the SQL misses, or changes a rank in one place only,
 * this fails. It parses the real rendered fragment rather than trusting the
 * builder, so the assertion is on what Postgres would actually execute.
 */
test('the rendered sourcePrecedenceSql CASE ranks every source consistently with rankSource()', async () => {
  const { sourcePrecedenceSql, rankSource, SOURCE_PRECEDENCE } = await import('./memoryTiers');

  const { sql: sqlText, params } = new PgDialect().sqlToQuery(
    sourcePrecedenceSql(realSchema.nodes.source) as never,
  );

  // Rebuild source -> rank purely from the rendered SQL. Sources render as
  // bound params ($1, $2, ...); ranks render as raw integers.
  const rendered = new Map<string, number>();
  for (const [, paramIndex, rank] of sqlText.matchAll(/when \$(\d+) then (-?\d+)/g)) {
    const source = params[Number(paramIndex) - 1];
    assert.equal(typeof source, 'string', 'each CASE arm must bind its source as a string param');
    rendered.set(source as string, Number(rank));
  }

  // Every declared tier must appear in the SQL with exactly its rankSource() value.
  for (const source of Object.keys(SOURCE_PRECEDENCE)) {
    assert.ok(rendered.has(source), `rendered CASE is missing a branch for source "${source}"`);
    assert.equal(
      rendered.get(source),
      rankSource(source),
      `rendered CASE rank for "${source}" disagrees with rankSource()`,
    );
  }
  // ...and the SQL must not invent branches beyond what's declared.
  assert.equal(rendered.size, Object.keys(SOURCE_PRECEDENCE).length);

  // The else arm must match rankSource()'s unknown-source fallback.
  const elseMatch = sqlText.match(/else (-?\d+) end/);
  assert.ok(elseMatch, 'rendered CASE must have an else arm');
  assert.equal(Number(elseMatch![1]), rankSource('some-source-that-does-not-exist'));

  // The column itself stays a quoted identifier, never a bound param.
  assert.match(sqlText, /^case "nodes"\."source" /);
});

test('sourcePrecedenceSql orders its CASE arms highest-rank-first', async () => {
  const { sourcePrecedenceSql } = await import('./memoryTiers');
  const { sql: sqlText } = new PgDialect().sqlToQuery(
    sourcePrecedenceSql(realSchema.nodes.source) as never,
  );
  const ranks = [...sqlText.matchAll(/then (-?\d+)/g)].map(([, rank]) => Number(rank));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
});

test('MEMORY_TIERS documents the source + weight convention for each tier', async () => {
  const { MEMORY_TIERS } = await import('./memoryTiers');
  assert.equal(MEMORY_TIERS.provisional.source, 'coach');
  assert.equal(MEMORY_TIERS.provisional.weight, 0.6);
  assert.equal(MEMORY_TIERS.consolidated.source, 'digest');
  assert.equal(MEMORY_TIERS.userConfirmed.source, 'confirmed');
  assert.equal(MEMORY_TIERS.userConfirmed.weight, 0.9);
});
