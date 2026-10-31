// Slice 6: adopting a database that EF Core created. The runner must RECORD 0001 (never execute it), keep every row, and still
// apply the later migrations (0002-0004). An EF-shaped schema is simulated by running the SQL files by hand, then adding the
// __EFMigrationsHistory table, so no .NET is needed. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const sql = (name) => readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
const EF_HISTORY = `CREATE TABLE "__EFMigrationsHistory" ("MigrationId" character varying(150) NOT NULL PRIMARY KEY, "ProductVersion" character varying(32) NOT NULL);
  INSERT INTO "__EFMigrationsHistory" VALUES ('20261018172656_AddNextChange', '10.0.0');`;

async function executeSqlScript(pool, script) {
  const statements = script.split(/;[ \t]*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) await pool.query(statement);
}

const state = async (pool) => {
  // The runner's own tracking table is created by migrate(), so it is excluded: only the application schema is compared.
  const columns = await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'avzar_schema_migrations'`);
  const fks = await pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'`);
  const arrays = await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'avzar_schema_migrations' AND data_type = 'ARRAY'`);
  return { columns: columns.rows[0].n, fks: fks.rows[0].n, arrays: arrays.rows[0].n };
};
const tracked = async (pool) => Object.fromEntries((await pool.query('SELECT name, adopted FROM avzar_schema_migrations ORDER BY name')).rows.map((r) => [r.name, r.adopted]));

describe('adopting an EF-created database', { skip: !url }, () => {
  const dbs = [];
  after(async () => { for (const d of dbs) await d.drop(); });
  const fresh = async (prefix) => { const d = await createTempDatabase(url, prefix); dbs.push(d); return d; };

  it('rejects an older EF migration history before applying Node migrations', async () => {
    const db = await fresh('avzar_adopt_old');
    await executeSqlScript(db.pool, await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ef-initial-schema.sql'), 'utf8'));
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await db.pool.query(`INSERT INTO "AspNetUsers" ("Id","FullName","CreatedAtUtc","EmailConfirmed","PhoneNumberConfirmed","TwoFactorEnabled","LockoutEnabled","AccessFailedCount")
      VALUES ($1,'Legacy User',now(),false,false,false,true,0)`, [userId]);
    const legacyTables = await db.pool.query(`SELECT
      to_regclass('"CustomerPortalGrants"') IS NULL AS no_portal_grants,
      to_regclass('"DataProtectionKeys"') IS NULL AS no_data_protection_keys,
      to_regclass('"EmailSuppressions"') IS NULL AS no_email_suppressions,
      to_regclass('"Materials"') IS NULL AS no_materials,
      to_regclass('"OwnershipTransferChallenges"') IS NULL AS no_ownership_challenges,
      to_regclass('"StockMovements"') IS NULL AS no_stock_movements,
      to_regclass('"SubscriptionPayments"') IS NULL AS no_subscription_payments,
      to_regclass('"WorkerAvailability"') IS NULL AS no_worker_availability,
      to_regclass('"WorkerLeaves"') IS NULL AS no_worker_leaves`);
    assert.ok(Object.values(legacyTables.rows[0]).every(Boolean), 'fixture is the historical EF schema before later table migrations');

    await assert.rejects(migrate(db.pool, MIGRATIONS_DIR, quiet), /Cannot safely adopt EF database at migration '20261015214018_InitialSchema'/);
    assert.deepEqual(await tracked(db.pool), {}, 'no Node migration is recorded');
    assert.deepEqual((await db.pool.query('SELECT "FullName" FROM "AspNetUsers" WHERE "Id" = $1', [userId])).rows, [{ FullName: 'Legacy User' }]);
    assert.deepEqual((await db.pool.query('SELECT "MigrationId" FROM "__EFMigrationsHistory"')).rows, [{ MigrationId: '20261015214018_InitialSchema' }], 'EF history is never touched');
  });

  it('adopts a schema marked with the latest supported EF migration', async () => {
    const db = await fresh('avzar_adopt_full');
    // Build the EF-created schema from the existing migrations, excluding the Node-only B6 table.
    // An EF-created database cannot already contain TaskWorkerRequests; the Node runner must apply 0009 once.
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.sql') && name < '0009_task_worker_requests.sql')
      .sort();
    for (const f of files) await db.pool.query(await sql(f));
    await db.pool.query(EF_HISTORY);
    const before = await state(db.pool);
    assert.equal((await db.pool.query(`SELECT to_regclass('"TaskWorkerRequests"') IS NULL AS missing`)).rows[0].missing, true);

    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    const afterState = await state(db.pool);

    assert.equal(
  afterState.columns,
  before.columns + 13 + 14 + 5 + 6 + 25 + 23 + 24 + 9 + 7 + 10 + 4 + 16 + 15 + 22 + 57 + 36 + 10 + 9 + 9 + 18 + 1 + 7 + 2 + 1 + 18 + 18 + 17 + 8,
  'the Node-only migrations (0009 task requests  through 0041 notification templates, including the stock ledger extension) add their expected columns'
);
    assert.equal(
  afterState.fks,
  before.fks + 3 + 5 + 2 + 6 + 5 + 2 + 2 + 4 + 2 + 1 + 5 + 3 + 4 + 9 + 8 + 2 + 1 + 1 + 4 + 4 + 1 + 1,
  'the Node-only migrations add their expected foreign keys through 0041 notification templates'
);
    assert.equal(afterState.arrays, before.arrays + 1, 'the calendar-feed migration adds only AllowedLocationIds as a new array column');
    assert.equal((await db.pool.query(`SELECT to_regclass('"TaskWorkerRequests"') IS NOT NULL AS present`)).rows[0].present, true);
    const applied = await tracked(db.pool);
    assert.equal(applied['0001_baseline.sql'], true);
    assert.equal(applied['0009_task_worker_requests.sql'], false);
  });

  it('a database with neither the EF history table nor AspNetUsers is treated as empty and gets the baseline executed', async () => {
    const db = await fresh('avzar_adopt_empty');
    const applied = await migrate(db.pool, MIGRATIONS_DIR, quiet);
    assert.equal(applied[0], '0001_baseline.sql');
    assert.equal((await tracked(db.pool))['0001_baseline.sql'], false);
  });
});
