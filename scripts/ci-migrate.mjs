import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationSchema = 'drizzle';
const migrationTable = '__drizzle_migrations';
const migrationFolder = path.resolve(process.cwd(), 'db/migrations');
const legacyTargetIndex = 16;
const legacyTargetTag = '0016_famous_sleepwalker';

export function validateDatabaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('DATABASE_URL must be set to a PostgreSQL connection URL.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error('DATABASE_URL must be a complete PostgreSQL connection URL.');
  }

  return url;
}

export function validateMigrationJournal(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new Error('PostgreSQL migration journal must be an object.');
  }
  if (journal.dialect !== 'postgresql') {
    throw new Error('PostgreSQL migration journal must declare the postgresql dialect.');
  }
  if (typeof journal.version !== 'string' || !/^\d+$/.test(journal.version)) {
    throw new Error('PostgreSQL migration journal must declare a numeric format version.');
  }
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('PostgreSQL migration journal must contain at least one entry.');
  }

  let previousWhen = -1;
  for (const [position, entry] of journal.entries.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.idx !== position ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousWhen ||
      typeof entry.tag !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.tag) ||
      typeof entry.breakpoints !== 'boolean'
    ) {
      throw new Error('PostgreSQL migration journal must contain ordered entries with safe tags.');
    }
    previousWhen = entry.when;
  }

  const head = journal.entries.at(-1);
  return { tag: head.tag, createdAt: head.when };
}

export function assertAppliedMigrationHead(appliedHead, expectedHead) {
  if (
    !appliedHead ||
    Number(appliedHead.createdAt) !== expectedHead.createdAt ||
    appliedHead.hash !== expectedHead.hash
  ) {
    throw new Error('Applied migration table does not match the committed journal head.');
  }
}

function stripOuterParentheses(value) {
  let result = value;
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let wrapsWholeExpression = true;
    let quoted = false;
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index];
      if (character === "'" && result[index - 1] !== '\\') quoted = !quoted;
      if (quoted) continue;
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function collapseRedundantParentheses(value) {
  let result = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < result.length - 1; index += 1) {
      if (result[index] !== '(' || result[index + 1] !== '(') continue;
      let depth = 0;
      let quoted = false;
      for (let cursor = index + 1; cursor < result.length; cursor += 1) {
        const character = result[cursor];
        if (character === "'" && result[cursor - 1] !== '\\') quoted = !quoted;
        if (quoted) continue;
        if (character === '(') depth += 1;
        if (character === ')') depth -= 1;
        if (depth === 0) {
          if (result[cursor + 1] === ')') {
            result = `${result.slice(0, index + 1)}${result.slice(index + 2, cursor)}${result.slice(cursor + 1)}`;
            changed = true;
          }
          break;
        }
      }
      if (changed) break;
    }
  }
  return result;
}

function lowercaseOutsideSqlStrings(value) {
  let quoted = false;
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      result += character;
      if (quoted && value[index + 1] === "'") {
        result += value[index + 1];
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    result += quoted ? character : character.toLowerCase();
  }
  return result;
}

export function normalizeSqlExpression(value) {
  if (value === undefined || value === null) return null;
  let normalized = lowercaseOutsideSqlStrings(String(value).trim())
    .replace(/"[^"]+"\."([^"]+)"/g, '$1')
    .replace(/"([^"]+)"/g, '$1')
    .replace(/::(?:character varying|timestamp with(?:out)? time zone|double precision|[a-z][a-z0-9_ ]*)(?:\[\])?/g, '')
    .replace(
      /\b([a-z_][a-z0-9_]*)\s+between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)/g,
      '$1 >= $2 and $1 <= $3',
    )
    .replace(/\b([a-z_][a-z0-9_]*)\s*=\s*any\s*\(\s*array\[(.*?)\]\s*\)/g, '$1 in ($2)');
  const atomicParentheses = [
    /\(([a-z_][a-z0-9_]*\s*(?:=|<>|<=|>=|<|>)\s*(?:'[^']*'|-?\d+(?:\.\d+)?|true|false))\)/g,
    /\(([a-z_][a-z0-9_]*\s+is\s+(?:not\s+)?null)\)/g,
    /\(([a-z_][a-z0-9_]*\s+between\s+-?\d+(?:\.\d+)?\s+and\s+-?\d+(?:\.\d+)?)\)/g,
    /\(([a-z_][a-z0-9_]*\s+in\s*\([^()]*\))\)/g,
  ];
  for (const pattern of atomicParentheses) normalized = normalized.replace(pattern, '$1');
  normalized = collapseRedundantParentheses(normalized)
    .replace(/\s+/g, ' ')
    .replace(/\s+and\s+/g, '&&')
    .replace(/\s+or\s+/g, '||')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*(=|<>|<=|>=|<|>)\s*/g, '$1');
  normalized = stripOuterParentheses(normalized);
  return collapseRedundantParentheses(normalized);
}

function sortByName(values) {
  return values.sort((left, right) => {
    const leftKey = `${left.name ?? ''}:${left.kind ?? ''}`;
    const rightKey = `${right.name ?? ''}:${right.kind ?? ''}`;
    return leftKey.localeCompare(rightKey);
  });
}

function normalizeSnapshotConstraint(table, constraint, kind) {
  if (kind === 'foreignKey') {
    return {
      kind,
      name: constraint.name,
      columns: [...constraint.columnsFrom],
      referencedTable: constraint.tableTo,
      referencedColumns: [...constraint.columnsTo],
      onDelete: constraint.onDelete ?? 'no action',
      onUpdate: constraint.onUpdate ?? 'no action',
    };
  }
  if (kind === 'check') {
    return { kind, name: constraint.name, expression: normalizeSqlExpression(constraint.value) };
  }
  return {
    kind,
    name: constraint.name,
    columns: [...constraint.columns],
    ...(kind === 'unique' ? { nullsNotDistinct: constraint.nullsNotDistinct === true } : {}),
  };
}

export function normalizeSnapshotSchema(snapshot) {
  if (!snapshot || snapshot.dialect !== 'postgresql' || !snapshot.tables) {
    throw new Error('Legacy adoption snapshot must be a PostgreSQL Drizzle snapshot.');
  }

  const tables = Object.values(snapshot.tables).map((table) => {
    const primaryKeyColumns = Object.values(table.columns)
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    const constraints = [];
    if (primaryKeyColumns.length > 0) {
      constraints.push({
        kind: 'primaryKey',
        name: `${table.name}_pkey`,
        columns: primaryKeyColumns,
      });
    }
    constraints.push(
      ...Object.values(table.compositePrimaryKeys ?? {}).map((constraint) =>
        normalizeSnapshotConstraint(table, constraint, 'primaryKey'),
      ),
      ...Object.values(table.uniqueConstraints ?? {}).map((constraint) =>
        normalizeSnapshotConstraint(table, constraint, 'unique'),
      ),
      ...Object.values(table.checkConstraints ?? {}).map((constraint) =>
        normalizeSnapshotConstraint(table, constraint, 'check'),
      ),
      ...Object.values(table.foreignKeys ?? {}).map((constraint) =>
        normalizeSnapshotConstraint(table, constraint, 'foreignKey'),
      ),
    );

    return {
      name: table.name,
      rlsEnabled: table.isRLSEnabled === true,
      columns: sortByName(
        Object.values(table.columns).map((column) => ({
          name: column.name,
          type: column.type.toLowerCase(),
          notNull: column.notNull === true,
          default: normalizeSqlExpression(column.default),
        })),
      ),
      constraints: sortByName(constraints),
      indexes: sortByName(
        Object.values(table.indexes ?? {}).map((index) => ({
          name: index.name,
          unique: index.isUnique === true,
          valid: true,
          ready: true,
          method: (index.method ?? 'btree').toLowerCase(),
          columns: index.columns.map((column) => ({
            expression: normalizeSqlExpression(column.expression),
            asc: column.asc !== false,
            nulls: column.nulls ?? (column.asc === false ? 'first' : 'last'),
            included: false,
          })),
          predicate: normalizeSqlExpression(index.where),
        })),
      ),
      policies: sortByName(Object.values(table.policies ?? {}).map((policy) => ({ name: policy.name }))),
    };
  });

  const extraObjects = [
    ...Object.keys(snapshot.views ?? {}).map((name) => ({ name, kind: 'view' })),
    ...Object.keys(snapshot.sequences ?? {}).map((name) => ({ name, kind: 'sequence' })),
  ];
  const customTypes = Object.keys(snapshot.enums ?? {}).map((name) => ({ name, kind: 'enum' }));

  return {
    tables: sortByName(tables),
    extraObjects: sortByName(extraObjects),
    customTypes: sortByName(customTypes),
  };
}

function normalizeCatalogConstraint(constraint) {
  if (constraint.kind === 'foreignKey') {
    return {
      kind: constraint.kind,
      name: constraint.constraint_name,
      columns: [...constraint.columns],
      referencedTable: constraint.referenced_table,
      referencedColumns: [...constraint.referenced_columns],
      onDelete: constraint.on_delete,
      onUpdate: constraint.on_update,
    };
  }
  if (constraint.kind === 'check') {
    return {
      kind: constraint.kind,
      name: constraint.constraint_name,
      expression: normalizeSqlExpression(constraint.expression),
    };
  }
  return {
    kind: constraint.kind,
    name: constraint.constraint_name,
    columns: [...constraint.columns],
    ...(constraint.kind === 'unique' ? { nullsNotDistinct: constraint.nulls_not_distinct === true } : {}),
  };
}

export function normalizeCatalogSchema(catalog) {
  const tables = catalog.tables.map((table) => ({
    name: table.table_name,
    rlsEnabled: table.rls_enabled === true,
    columns: sortByName(
      catalog.columns
        .filter((column) => column.table_name === table.table_name)
        .map((column) => ({
          name: column.column_name,
          type: column.data_type.toLowerCase(),
          notNull: column.not_null === true,
          default: normalizeSqlExpression(column.default_expr),
        })),
    ),
    constraints: sortByName(
      catalog.constraints
        .filter((constraint) => constraint.table_name === table.table_name)
        .map(normalizeCatalogConstraint),
    ),
    indexes: sortByName(
      catalog.indexes
        .filter((index) => index.table_name === table.table_name)
        .map((index) => ({
          name: index.index_name,
          unique: index.unique === true,
          valid: index.valid !== false,
          ready: index.ready !== false,
          method: index.method.toLowerCase(),
          columns: index.columns.map((column) => ({
            expression: normalizeSqlExpression(column.expression),
            asc: column.asc === true,
            nulls: column.nulls,
            included: column.included === true,
          })),
          predicate: normalizeSqlExpression(index.predicate),
        })),
    ),
    policies: sortByName(
      catalog.policies
        .filter((policy) => policy.table_name === table.table_name)
        .map((policy) => ({ name: policy.policy_name })),
    ),
  }));

  return {
    tables: sortByName(tables),
    extraObjects: sortByName(
      catalog.extra_objects.map((object) => ({ name: object.name, kind: object.kind })),
    ),
    customTypes: sortByName(
      catalog.custom_types.map((type) => ({ name: type.name, kind: type.kind })),
    ),
  };
}

function stableValue(value) {
  return value === undefined ? '<missing>' : JSON.stringify(value);
}

export function diffCanonicalSchemas(expected, actual, location = 'schema') {
  if (Object.is(expected, actual)) return [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const differences = [];
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const identity = expected[index]?.name ?? actual[index]?.name ?? index;
      differences.push(...diffCanonicalSchemas(expected[index], actual[index], `${location}.${identity}`));
    }
    return differences;
  }
  if (
    expected &&
    actual &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap((key) => diffCanonicalSchemas(expected[key], actual[key], `${location}.${key}`));
  }
  return [`${location}: expected ${stableValue(expected)}, received ${stableValue(actual)}`];
}

export function assertLegacySchemaMatches(expected, actual) {
  const differences = diffCanonicalSchemas(expected, actual);
  if (differences.length > 0) {
    throw new Error(
      `Live public schema does not exactly match committed 0016 snapshot:\n${differences.slice(0, 20).join('\n')}`,
    );
  }
}

function assertLegacyTarget(artifacts) {
  if (artifacts[legacyTargetIndex]?.idx !== legacyTargetIndex || artifacts[legacyTargetIndex]?.tag !== legacyTargetTag) {
    throw new Error(`Committed migration journal does not contain required legacy target ${legacyTargetTag}.`);
  }
}

export function classifyLegacyLedger(appliedRows, artifacts) {
  assertLegacyTarget(artifacts);
  if (appliedRows.length === 0) return 'fresh';

  const headIndex = appliedRows.length - 1;
  assertCommittedLedgerPrefix(appliedRows, artifacts, headIndex);
  if (headIndex === 0) return 'adopt';
  if (headIndex < legacyTargetIndex) {
    throw new Error(
      `Found unexpected stale migration ledger at ${artifacts[headIndex].tag}; inspect production manually before retrying.`,
    );
  }
  return 'current';
}

export function assertCommittedLedgerPrefix(appliedRows, artifacts, expectedHeadIndex) {
  const expectedHead = artifacts[expectedHeadIndex];
  const expectedLength = expectedHeadIndex + 1;
  if (
    !Number.isInteger(expectedHeadIndex) ||
    expectedHeadIndex < 0 ||
    !expectedHead ||
    appliedRows.length !== expectedLength
  ) {
    throw new Error(
      'Migration ledger is not the exact contiguous committed prefix; inspect production manually before retrying.',
    );
  }

  for (let index = 0; index < expectedLength; index += 1) {
    const applied = appliedRows[index];
    const committed = artifacts[index];
    if (
      !applied ||
      Number(applied.createdAt) !== committed.createdAt ||
      applied.hash !== committed.hash
    ) {
      throw new Error(
        `Migration ledger is not the exact contiguous committed prefix through ${expectedHead.tag}; mismatch at position ${index}. Inspect production manually before retrying.`,
      );
    }
  }
}

export function buildLegacyStampingPlan(appliedRows, artifacts) {
  if (classifyLegacyLedger(appliedRows, artifacts) !== 'adopt') {
    throw new Error('Legacy stamping is only allowed from the exact known 0000 ledger state.');
  }
  return artifacts.slice(1, legacyTargetIndex + 1);
}

export async function performLegacyAdoption({
  artifacts,
  expectedSchema,
  withTransaction,
  acquireLock,
  readLedger,
  readCatalog,
  insertMigration,
}) {
  return withTransaction(async (transaction) => {
    await acquireLock(transaction);
    const initialLedger = await readLedger(transaction);
    const initialState = classifyLegacyLedger(initialLedger, artifacts);
    if (initialState !== 'adopt') return initialState;

    const actualSchema = normalizeCatalogSchema(await readCatalog(transaction));
    assertLegacySchemaMatches(expectedSchema, actualSchema);

    // The advisory lock serializes cooperating release gates; the second read
    // also makes any unexpected ledger mutation fail closed before inserts.
    const recheckedLedger = await readLedger(transaction);
    const stampingPlan = buildLegacyStampingPlan(recheckedLedger, artifacts);
    for (const migration of stampingPlan) {
      await insertMigration(transaction, migration);
    }

    const adoptedLedger = await readLedger(transaction);
    assertCommittedLedgerPrefix(adoptedLedger, artifacts, legacyTargetIndex);
    return 'adopted';
  });
}

export async function loadCommittedMigrationState(folder) {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read committed migration journal: ${error.message}`);
  }

  validateMigrationJournal(journal);
  const artifacts = await Promise.all(
    journal.entries.map(async (entry) => {
      const sqlPath = path.join(folder, `${entry.tag}.sql`);
      let sql;
      try {
        sql = await readFile(sqlPath, 'utf8');
      } catch (error) {
        throw new Error(`Unable to read committed migration ${entry.tag}: ${error.message}`);
      }
      return {
        idx: entry.idx,
        tag: entry.tag,
        createdAt: entry.when,
        hash: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  assertLegacyTarget(artifacts);

  const snapshotPath = path.join(
    folder,
    'meta',
    `${String(legacyTargetIndex).padStart(4, '0')}_snapshot.json`,
  );
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read committed legacy snapshot ${legacyTargetTag}: ${error.message}`);
  }

  return {
    artifacts,
    expectedLegacySchema: normalizeSnapshotSchema(snapshot),
    expectedHead: artifacts.at(-1),
  };
}

async function readMigrationLedger(transaction) {
  const [ledgerTable] = await transaction.unsafe(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as ledger_exists",
  );
  if (!ledgerTable?.ledger_exists) return [];

  const rows = await transaction.unsafe(
    'select hash, created_at from "drizzle"."__drizzle_migrations" order by created_at asc, id asc',
  );
  return rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

async function readPublicCatalog(transaction) {
  const [tables, columns, constraints, indexes, policies, extraObjects, customTypes] = await Promise.all([
    transaction.unsafe(`
      select c.relname as table_name, c.relrowsecurity as rls_enabled
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname
    `),
    transaction.unsafe(`
      select
        c.relname as table_name,
        a.attname as column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
        a.attnotnull as not_null,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid, false) as default_expr
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and a.attnum > 0
        and not a.attisdropped
      order by c.relname, a.attnum
    `),
    transaction.unsafe(`
      select
        source.relname as table_name,
        con.conname as constraint_name,
        case con.contype
          when 'p' then 'primaryKey'
          when 'u' then 'unique'
          when 'c' then 'check'
          when 'f' then 'foreignKey'
        end as kind,
        array(
          select source_attribute.attname
          from unnest(con.conkey) with ordinality as key(attnum, position)
          join pg_catalog.pg_attribute source_attribute
            on source_attribute.attrelid = con.conrelid and source_attribute.attnum = key.attnum
          order by key.position
        ) as columns,
        referenced.relname as referenced_table,
        array(
          select referenced_attribute.attname
          from unnest(con.confkey) with ordinality as key(attnum, position)
          join pg_catalog.pg_attribute referenced_attribute
            on referenced_attribute.attrelid = con.confrelid and referenced_attribute.attnum = key.attnum
          order by key.position
        ) as referenced_columns,
        case con.confdeltype
          when 'a' then 'no action'
          when 'r' then 'restrict'
          when 'c' then 'cascade'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as on_delete,
        case con.confupdtype
          when 'a' then 'no action'
          when 'r' then 'restrict'
          when 'c' then 'cascade'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as on_update,
        coalesce(constraint_index.indnullsnotdistinct, false) as nulls_not_distinct,
        case when con.contype = 'c'
          then pg_catalog.pg_get_expr(con.conbin, con.conrelid, false)
        end as expression
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class source on source.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = source.relnamespace
      left join pg_catalog.pg_class referenced on referenced.oid = con.confrelid
      left join pg_catalog.pg_index constraint_index on constraint_index.indexrelid = con.conindid
      where n.nspname = 'public' and con.contype in ('p', 'u', 'c', 'f')
      order by source.relname, con.conname
    `),
    transaction.unsafe(`
      select
        source.relname as table_name,
        index_relation.relname as index_name,
        index_data.indisunique as unique,
        index_data.indisvalid as valid,
        index_data.indisready as ready,
        access_method.amname as method,
        (
          select json_agg(
            json_build_object(
              'expression', pg_catalog.pg_get_indexdef(index_data.indexrelid, key.position, false),
              'asc', (index_data.indoption[key.position - 1] & 1) = 0,
              'nulls', case when (index_data.indoption[key.position - 1] & 2) = 2 then 'first' else 'last' end,
              'included', key.position > index_data.indnkeyatts
            ) order by key.position
          )
          from generate_series(1, index_data.indnatts) as key(position)
        ) as columns,
        pg_catalog.pg_get_expr(index_data.indpred, index_data.indrelid, false) as predicate
      from pg_catalog.pg_index index_data
      join pg_catalog.pg_class source on source.oid = index_data.indrelid
      join pg_catalog.pg_namespace n on n.oid = source.relnamespace
      join pg_catalog.pg_class index_relation on index_relation.oid = index_data.indexrelid
      join pg_catalog.pg_am access_method on access_method.oid = index_relation.relam
      left join pg_catalog.pg_constraint backing_constraint
        on backing_constraint.conindid = index_data.indexrelid
      where n.nspname = 'public' and backing_constraint.oid is null
      order by source.relname, index_relation.relname
    `),
    transaction.unsafe(`
      select source.relname as table_name, policy.polname as policy_name
      from pg_catalog.pg_policy policy
      join pg_catalog.pg_class source on source.oid = policy.polrelid
      join pg_catalog.pg_namespace n on n.oid = source.relnamespace
      where n.nspname = 'public'
      order by source.relname, policy.polname
    `),
    transaction.unsafe(`
      select
        c.relname as name,
        case c.relkind
          when 'v' then 'view'
          when 'm' then 'materialized view'
          when 'S' then 'sequence'
          when 'f' then 'foreign table'
        end as kind
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm', 'S', 'f')
      order by c.relname
    `),
    transaction.unsafe(`
      select
        type.typname as name,
        case type.typtype when 'e' then 'enum' when 'd' then 'domain' end as kind
      from pg_catalog.pg_type type
      join pg_catalog.pg_namespace n on n.oid = type.typnamespace
      where n.nspname = 'public' and type.typtype in ('e', 'd')
      order by type.typname
    `),
  ]);

  return {
    tables: [...tables],
    columns: [...columns],
    constraints: [...constraints],
    indexes: [...indexes],
    policies: [...policies],
    extra_objects: [...extraObjects],
    custom_types: [...customTypes],
  };
}

function createLegacyAdoptionDependencies(client) {
  return {
    withTransaction: (callback) => client.begin(callback),
    acquireLock: (transaction) =>
      transaction.unsafe('select pg_catalog.pg_advisory_xact_lock($1::bigint)', [7419261741416]),
    readLedger: readMigrationLedger,
    readCatalog: readPublicCatalog,
    insertMigration: (transaction, migration) =>
      transaction.unsafe(
        'insert into "drizzle"."__drizzle_migrations" (hash, created_at) values ($1, $2)',
        [migration.hash, migration.createdAt],
      ),
  };
}

async function closeClient(client, operationFailed) {
  try {
    await client.end({ timeout: 5 });
  } catch (error) {
    if (!operationFailed) {
      throw error;
    }
    console.error(`Migration database connection did not close cleanly: ${error.message}`);
  }
}

export async function runMigrations({ databaseUrl = process.env.DATABASE_URL, migrationsFolder = migrationFolder } = {}) {
  const url = validateDatabaseUrl(databaseUrl);
  const committedState = await loadCommittedMigrationState(migrationsFolder);
  let client;
  let operationFailed = true;

  try {
    // `npm ci` installs the package-lock-pinned drizzle-orm version. Its
    // migrator reads only this folder's journal and SQL files; no schema diff
    // command or drizzle-kit push path is used in production.
    const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
      import('postgres'),
      import('drizzle-orm/postgres-js'),
      import('drizzle-orm/postgres-js/migrator'),
    ]);

    client = postgres(url.toString(), {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
    });
    const db = drizzle(client);

    const adoptionState = await performLegacyAdoption({
      artifacts: committedState.artifacts,
      expectedSchema: committedState.expectedLegacySchema,
      ...createLegacyAdoptionDependencies(client),
    });
    if (adoptionState === 'adopted') {
      console.log(`Verified live schema and adopted migration ledger through ${legacyTargetTag}.`);
    }

    await migrate(db, {
      migrationsFolder,
      migrationsSchema: migrationSchema,
      migrationsTable: migrationTable,
    });

    const appliedLedger = await readMigrationLedger(client);
    assertCommittedLedgerPrefix(
      appliedLedger,
      committedState.artifacts,
      committedState.artifacts.length - 1,
    );
    operationFailed = false;
    console.log(`Migration head verified: ${committedState.expectedHead.tag}`);
  } finally {
    if (client) {
      await closeClient(client, operationFailed);
    }
  }
}

async function main() {
  await runMigrations();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Production migration gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
