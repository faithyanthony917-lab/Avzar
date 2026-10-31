#!/usr/bin/env node
// Read-only schema drift checker. Run it against an existing PostgreSQL BEFORE cutover:
//   DATABASE_URL=postgres://... node scripts/check-schema.js
//   (or: DATABASE_URL=... npm run check-schema)
// It only SELECTs from information_schema inside a READ ONLY transaction and never writes.
// It prints what the Node code needs but the database lacks: tables, columns, NOT NULL, array column types, foreign keys.
// Exit code: 0 = nothing missing, 1 = something missing, 2 = could not run.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

// Columns the EF model declares as PostgreSQL arrays (information_schema reports udt_name: _text / _uuid).
export const ARRAY_COLUMNS = [
  ['Designs', 'Tags', '_text'], ['Designs', 'Fabrics', '_text'], ['Designs', 'Colours', '_text'], ['Designs', 'Sizes', '_text'],
  ['Workflows', 'GarmentCategories', '_text'], ['Stages', 'CompletionChecks', '_text'],
  ['ProductionTasks', 'RequiredChecks', '_text'], ['ProductionTasks', 'CompletedChecks', '_text'],
  ['Invitations', 'RoleIds', '_uuid'], ['Invitations', 'LocationIds', '_uuid'],
];

// Foreign keys the baseline generator skipped and migration 0004 adds: [table, columns in order, referenced table].
export const REQUIRED_FKS = [
  ['WorkerAvailability', ['BusinessId'], 'Businesses'], ['WorkerAvailability', ['MembershipId', 'BusinessId'], 'Memberships'],
  ['WorkerLeaves', ['BusinessId'], 'Businesses'], ['WorkerLeaves', ['MembershipId', 'BusinessId'], 'Memberships'],
  ['Materials', ['BusinessId'], 'Businesses'], ['Materials', ['LocationId', 'BusinessId'], 'Locations'],
  ['StockMovements', ['BusinessId'], 'Businesses'], ['StockMovements', ['MaterialId', 'BusinessId'], 'Materials'],
  ['OwnershipTransferChallenges', ['BusinessId'], 'Businesses'], ['OwnershipTransferChallenges', ['NewOwnerMembershipId', 'BusinessId'], 'Memberships'],
  ['CustomerPortalGrants', ['BusinessId'], 'Businesses'], ['CustomerPortalGrants', ['CustomerId', 'BusinessId'], 'Customers'],
  ['SubscriptionPayments', ['BusinessId'], 'Businesses'], ['SubscriptionPayments', ['PlanId'], 'Plans'],
];

const COLUMNS_SQL = `SELECT table_name, column_name, udt_name, is_nullable
  FROM information_schema.columns WHERE table_schema = 'public'`;

// Composite foreign keys keep their column order through position_in_unique_constraint.
const FKS_SQL = `SELECT tc.table_name AS tbl, tc.constraint_name AS name, ref.table_name AS ref_tbl,
       array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS cols
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_schema = tc.constraint_schema AND rc.constraint_name = tc.constraint_name
  JOIN information_schema.table_constraints ref
    ON ref.constraint_schema = rc.unique_constraint_schema AND ref.constraint_name = rc.unique_constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  GROUP BY tc.table_name, tc.constraint_name, ref.table_name`;

/** Pure comparison: rows come from the two queries above, baseline from 0001_baseline.schema.json. */
export function compareSchema({ columnRows, fkRows, baseline }) {
  const columns = new Map(columnRows.map((r) => [`${r.table_name}.${r.column_name}`, { udt: r.udt_name, nullable: r.is_nullable === 'YES' }]));
  const tables = new Set(columnRows.map((r) => r.table_name));
  const missingTables = [];
  const missingColumns = [];
  const nullabilityDiffs = [];
  const arrayProblems = [];
  const missingFks = [];

  for (const [table, def] of Object.entries(baseline)) {
    if (!tables.has(table)) { missingTables.push(table); continue; }
    for (const [col, c] of Object.entries(def.columns)) {
      const have = columns.get(`${table}.${col}`);
      if (!have) missingColumns.push(`${table}.${col}`);
      else if (!c.nullable && have.nullable) nullabilityDiffs.push(`${table}.${col} is nullable, the model says NOT NULL`);
    }
  }
  for (const [table, col, udt] of ARRAY_COLUMNS) {
    if (!tables.has(table)) { if (!missingTables.includes(table)) missingTables.push(table); continue; }
    const have = columns.get(`${table}.${col}`);
    if (!have) { if (!missingColumns.includes(`${table}.${col}`)) missingColumns.push(`${table}.${col}`); continue; }
    if (have.udt !== udt) arrayProblems.push(`${table}.${col} has type ${have.udt}, expected ${udt}`);
    if (have.nullable) arrayProblems.push(`${table}.${col} is nullable, expected NOT NULL`);
  }
  const haveFks = new Set(fkRows.map((r) => `${r.tbl}|${r.cols.join(',')}|${r.ref_tbl}`));
  for (const [table, cols, ref] of REQUIRED_FKS) {
    if (tables.has(table) && tables.has(ref) && !haveFks.has(`${table}|${cols.join(',')}|${ref}`)) missingFks.push(`${table}(${cols.join(', ')}) -> ${ref}`);
  }
  const problems = missingTables.length + missingColumns.length + arrayProblems.length + missingFks.length;
  return { missingTables, missingColumns, nullabilityDiffs, arrayProblems, missingFks, problems };
}

export function formatReport(result) {
  const lines = [];
  const section = (title, items) => { if (items.length) { lines.push(`${title} (${items.length}):`, ...items.map((i) => `  - ${i}`)); } };
  section('MISSING TABLES', result.missingTables);
  section('MISSING COLUMNS', result.missingColumns);
  section('ARRAY COLUMN PROBLEMS', result.arrayProblems);
  section('MISSING FOREIGN KEYS', result.missingFks);
  section('NOT NULL DIFFERENCES (warning, does not fail the check)', result.nullabilityDiffs);
  lines.push(result.problems === 0
    ? 'OK: every table, column, array column and foreign key the Node code needs is present.'
    : `FAIL: ${result.problems} problem(s). Run "npm run migrate" (forward-only, additive) to fix them, then run this check again.`);
  return lines.join('\n');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required.'); return 2; }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const columnRows = (await client.query(COLUMNS_SQL)).rows;
    const fkRows = (await client.query(FKS_SQL)).rows;
    await client.query('ROLLBACK');
    const baseline = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, '0001_baseline.schema.json'), 'utf8'));
    const result = compareSchema({ columnRows, fkRows, baseline });
    console.log(formatReport(result));
    return result.problems === 0 ? 0 : 1;
  } catch (error) {
    console.error(`Could not check the schema: ${error.message}`);
    return 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
