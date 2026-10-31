// Slice 6: a database built ONLY from the Node migrations must contain everything the EF model had.
// Runs against a throw-away database; skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { migrate } from '../../src/db/migrate.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;

// Columns the EF snapshot declares as PrimitiveCollection<...> (PostgreSQL arrays). The baseline generator skipped all ten.
const ARRAY_COLUMNS = [
  ['Designs', 'Tags', '_text'], ['Designs', 'Fabrics', '_text'], ['Designs', 'Colours', '_text'], ['Designs', 'Sizes', '_text'],
  ['Workflows', 'GarmentCategories', '_text'], ['Stages', 'CompletionChecks', '_text'],
  ['ProductionTasks', 'RequiredChecks', '_text'], ['ProductionTasks', 'CompletedChecks', '_text'],
  ['Invitations', 'RoleIds', '_uuid'], ['Invitations', 'LocationIds', '_uuid'],
];
// Foreign keys the generator skipped (compact snapshot entries): [table, columns, referenced table].
const MISSING_FKS = [
  ['WorkerAvailability', ['BusinessId'], 'Businesses'], ['WorkerAvailability', ['MembershipId', 'BusinessId'], 'Memberships'],
  ['WorkerLeaves', ['BusinessId'], 'Businesses'], ['WorkerLeaves', ['MembershipId', 'BusinessId'], 'Memberships'],
  ['Materials', ['BusinessId'], 'Businesses'], ['Materials', ['LocationId', 'BusinessId'], 'Locations'],
  ['StockMovements', ['BusinessId'], 'Businesses'], ['StockMovements', ['MaterialId', 'BusinessId'], 'Materials'],
  ['OwnershipTransferChallenges', ['BusinessId'], 'Businesses'], ['OwnershipTransferChallenges', ['NewOwnerMembershipId', 'BusinessId'], 'Memberships'],
  ['CustomerPortalGrants', ['BusinessId'], 'Businesses'], ['CustomerPortalGrants', ['CustomerId', 'BusinessId'], 'Customers'],
  ['SubscriptionPayments', ['BusinessId'], 'Businesses'], ['SubscriptionPayments', ['PlanId'], 'Plans'],
];

describe('schema built only from the Node migrations', { skip: !url }, () => {
  let db;
  let columns; // Map "Table.Column" -> { udt, nullable, def }
  let applied;
  before(async () => {
    db = await createTempDatabase(url, 'avzar_schema');
    applied = await migrate(db.pool, MIGRATIONS_DIR, quiet);
    const r = await db.pool.query(`SELECT table_name, column_name, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public'`);
    columns = new Map(r.rows.map((x) => [`${x.table_name}.${x.column_name}`, { udt: x.udt_name, nullable: x.is_nullable === 'YES', def: x.column_default }]));
  });
  after(async () => { await db?.drop(); });

  it('applies every migration on an empty database and a second run applies nothing', async () => {
    assert.ok(applied.includes('0001_baseline.sql') && applied.includes('0004_fresh_db_arrays_and_fks.sql'));
    assert.deepEqual(await migrate(db.pool, MIGRATIONS_DIR, quiet), []);
  });

  it('has every table and column of the baseline schema file', async () => {
    const schema = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, '0001_baseline.schema.json'), 'utf8'));
    const missing = [];
    for (const [table, def] of Object.entries(schema)) {
      for (const [col, c] of Object.entries(def.columns)) {
        const have = columns.get(`${table}.${col}`);
        if (!have) { missing.push(`${table}.${col}`); continue; }
        if (!c.nullable && have.nullable) missing.push(`${table}.${col} (should be NOT NULL)`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('creates tenant-scoped worker requests with a single pending request per task and type', async () => {
    assert.ok(columns.has('TaskWorkerRequests.Id'));
    assert.ok(columns.has('TaskWorkerRequests.BusinessId'));
    assert.ok(columns.has('TaskWorkerRequests.TaskId'));
    assert.ok(columns.has('TaskWorkerRequests.RequestedByMembershipId'));
    const index = await db.pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'IX_TaskWorkerRequests_PendingTaskType'`);
    assert.equal(index.rows.length, 1);
    assert.match(index.rows[0].indexdef, /UNIQUE INDEX/);
    assert.match(index.rows[0].indexdef, /WHERE.*Pending/);
    const fk = await db.pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"TaskWorkerRequests"'::regclass AND contype = 'f'`);
    assert.equal(fk.rows[0].n, 3);
  });

  it('has every PostgreSQL array column of the EF model, NOT NULL with an empty default', () => {
    for (const [table, col, udt] of ARRAY_COLUMNS) {
      const have = columns.get(`${table}.${col}`);
      assert.ok(have, `${table}.${col} is missing`);
      assert.equal(have.udt, udt, `${table}.${col} type`);
      assert.equal(have.nullable, false, `${table}.${col} nullable`);
      assert.ok(have.def, `${table}.${col} has no default`);
    }
  });

  it('preserves the stock ledger columns used by existing inventory workflows', async () => {
    const r = await db.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='StockMovements'`);
    const columns = new Set(r.rows.map((row) => row.column_name));
    for (const name of ['Kind', 'Quantity', 'OnHandAfter', 'ReservedAfter', 'OrderId', 'TaskId', 'ActorUserId', 'Note', 'CreatedAtUtc', 'MovementType', 'QuantityDelta', 'IdempotencyKey']) {
      assert.ok(columns.has(name), `StockMovements.${name} is required by existing or new stock workflows`);
    }
  });

  it('links purchase-order receipts to an optional expense category', async () => {
    const r = await db.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='PurchaseOrders' AND column_name='ExpenseCategoryId'`);
    assert.equal(r.rowCount, 1);
    const fk = await db.pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='"PurchaseOrders"'::regclass AND conname='FK_PurchaseOrders_ExpenseCategories_ExpenseCategoryId_BusinessId' AND contype='f'`);
    assert.equal(fk.rows[0].n, 1);
  });

  it('enforces RLS on supplier and purchase-order tables and fails closed without tenant context', async () => {
    const r = await db.pool.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.qual, p.with_check
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_policies p ON p.schemaname='public' AND p.tablename=c.relname AND p.policyname='avzar_business_isolation'
      WHERE n.nspname='public' AND c.relname IN ('Suppliers','PurchaseOrders','PurchaseOrderItems')
      ORDER BY c.relname`);
    assert.deepEqual(r.rows.map((x) => [x.relname, x.relrowsecurity, x.relforcerowsecurity, Boolean(x.qual), Boolean(x.with_check)]), [
      ['PurchaseOrderItems', true, true, true, true],
      ['PurchaseOrders', true, true, true, true],
      ['Suppliers', true, true, true, true],
    ]);
    for (const row of r.rows) {
      assert.match(row.qual, /app\.business_id/);
      assert.match(row.with_check, /app\.business_id/);
    }
  });

  it('creates durable consent-gated customer appointment reminders', async () => {
    const r = await db.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='CustomerMessageOutbox'`);
    const names = new Set(r.rows.map((row) => row.column_name));
    for (const name of ['BusinessId','AppointmentId','CustomerId','Channel','Address','AppointmentStartUtc','OffsetMinutes','DueAtUtc','Status','Attempts','NextAttemptUtc','LeaseUntilUtc','ProviderMessageId']) {
      assert.ok(names.has(name), `CustomerMessageOutbox.${name} is required for durable reminder delivery`);
    }
    const triggers = await db.pool.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('TR_Appointments_CustomerReminders','TR_CustomerMessagingPreferences_Outbox')`);
    assert.deepEqual(new Set(triggers.rows.map((row) => row.tgname)), new Set(['TR_Appointments_CustomerReminders','TR_CustomerMessagingPreferences_Outbox']));
  });

  it('has the foreign keys the baseline generator skipped', async () => {
    const r = await db.pool.query(`
      SELECT c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
      FROM pg_constraint c WHERE c.contype = 'f'`);
    const have = new Set(r.rows.map((x) => `${x.tbl.replaceAll('"', '')}|${x.cols.join(',')}|${x.ref.replaceAll('"', '')}`));
    const missing = MISSING_FKS.filter(([t, cols, ref]) => !have.has(`${t}|${cols.join(',')}|${ref}`));
    assert.deepEqual(missing, []);
  });
});
