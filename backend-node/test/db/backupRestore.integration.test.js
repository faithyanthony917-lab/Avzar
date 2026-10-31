// Step-10: a real backup and restore, end to end. Builds a database with two businesses through the real API (restricted role, the way
// staging runs), dumps it with pg_dump in custom format, restores it into an empty database with the unchanged
// scripts/verify-postgres-restore.sh, then proves the restored copy is the same data AND still enforces tenant isolation: row counts,
// policy and forced-RLS parity, no migration left to apply, check-schema clean, and a restricted-role login and cross-tenant check
// through the real app. Also records why pg_dump must not run as the application role (RLS makes it fail).
// Needs pg_dump, pg_restore and psql on PATH at the SAME major version as the server or newer; it fails (it does not skip) when they are
// missing or older. Skipped only when DATABASE_URL is not set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { PASSWORD, confirmedOrder, firstLocationId, paidInvoice, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, '../..');
const RESTORE_SCRIPT = path.resolve(HERE, '../../../scripts/verify-postgres-restore.sh');
const COUNTED_TABLES = ['Businesses', 'AspNetUsers', 'Memberships', 'Customers', 'Orders', 'Invoices', 'Payments', 'ProductionTasks', 'AuditLogs', 'EmailOutbox', 'avzar_schema_migrations'];

const major = (text) => Number(/(\d+)(?:\.\d+)*/.exec(text)?.[1] ?? 0);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });

async function countRows(pool) {
  const counts = {};
  for (const table of COUNTED_TABLES) counts[table] = (await pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;
  return counts;
}

async function securityShape(pool) {
  const policies = (await pool.query('SELECT policyname, count(*)::int AS n FROM pg_policies GROUP BY policyname ORDER BY policyname')).rows;
  const forced = (await pool.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity`)).rows[0].n;
  return { policies, forced };
}

describe('backup and restore (real pg_dump and pg_restore)', { skip: !url }, () => {
  let source; let role; let api; let owner; let other; let ids; let tmp; let dumpFile; let restored; let restoredRole; let restoredApi;
  let baseline;

  before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'avzar-backup-'));
    dumpFile = path.join(tmp, 'avzar.dump');
    source = await createTempDatabase(url, 'avzar_bk_src');
    await migrate(source.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(source.pool);
    role = await createRestrictedAppPool(source);
    api = await startApp(role.pool);
    owner = await signUp(api, 'bka');
    other = await signUp(api, 'bkb');
    const locationId = await firstLocationId(source, owner.businessId);
    const confirmed = await confirmedOrder(api, source, owner, locationId, 'bka');
    const paid = await paidInvoice(api, owner, confirmed.orderId);
    const otherCustomer = await api.call('POST', '/api/customers', { token: other.token, body: { fullName: 'bkb customer', email: 'bkb-customer@example.test', phone: '+2348011111111' } });
    assert.equal(otherCustomer.status, 201, otherCustomer.text);
    ids = { order: confirmed.orderId, customer: confirmed.customerId, invoice: paid.invoiceId, otherCustomer: otherCustomer.body.id };
    // Stop all application traffic before counting, so the counts and the dump see the same data.
    await api.close();
    api = null;
    baseline = { counts: await countRows(source.pool), shape: await securityShape(source.pool) };
  });

  after(async () => {
    await restoredApi?.close();
    await api?.close();
    await restoredRole?.close();
    await role?.close();
    await restored?.drop();
    await source?.drop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('the fixtures are real: several businesses, an order, a paid invoice, and an application pool that is a restricted role', async () => {
    await assertRestrictedRole(role.pool);
    assert.equal(baseline.counts.Businesses, 2);
    for (const table of ['Customers', 'Orders', 'Invoices', 'Payments', 'ProductionTasks', 'AuditLogs']) assert.ok(baseline.counts[table] > 0, `${table} should have rows before the backup`);
    assert.ok(baseline.shape.forced > 0, 'forced row-level security should be on before the backup');
    assert.ok(baseline.shape.policies.some((p) => p.policyname === 'avzar_business_isolation' && p.n > 0));
  });

  it('pg_dump, pg_restore and psql are installed and not older than the server', async () => {
    const serverMajor = Math.floor(Number((await source.pool.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    for (const tool of ['pg_dump', 'pg_restore', 'psql']) {
      const result = run(tool, ['--version']);
      assert.equal(result.status, 0, `${tool} is not installed or not on PATH: ${result.error?.message ?? result.stderr}`);
      assert.ok(major(result.stdout) >= serverMajor, `${tool} is version ${major(result.stdout)} but the server is ${serverMajor}; install postgresql-client-${serverMajor} (${result.stdout.trim()})`);
    }
  });

  it('pg_dump fails when run as the application role, because row-level security would hide rows', () => {
    const appUrl = new URL(source.url);
    appUrl.username = role.roleName;
    appUrl.password = 'pw';
    const attempt = run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(tmp, 'app-role.dump'), appUrl.toString()]);
    assert.notEqual(attempt.status, 0, 'a dump taken as the restricted application role must not succeed: it would be incomplete');
    assert.match(attempt.stderr, /row[- ]level security|row security/i, attempt.stderr);
  });

  it('takes a custom-format backup as the database owner', () => {
    const dump = run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpFile, source.url]);
    assert.equal(dump.status, 0, dump.stderr);
    assert.ok(statSync(dumpFile).size > 0, 'the backup file must not be empty');
    assert.equal(run('pg_restore', ['--list', dumpFile]).status, 0, 'pg_restore must be able to read the archive');
  });

  it('restores into an empty database with scripts/verify-postgres-restore.sh', async () => {
    restored = await createTempDatabase(url, 'avzar_bk_dst');
    const result = run('bash', [RESTORE_SCRIPT], { env: { ...process.env, BACKUP_FILE: dumpFile, RESTORE_TEST_DATABASE_URL: restored.url } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /restore_verified/);
  });

  it('the restored database holds exactly the rows that were backed up', async () => {
    assert.deepEqual(await countRows(restored.pool), baseline.counts);
  });

  it('policies and forced row-level security came back unchanged', async () => {
    assert.deepEqual(await securityShape(restored.pool), baseline.shape);
  });

  it('no migration is left to apply and no checksum has changed', async () => {
    assert.deepEqual(await migrate(restored.pool, MIGRATIONS_DIR, quiet), []);
  });

  it('check-schema finds nothing missing in the restored database', () => {
    const result = run('node', ['scripts/check-schema.js'], { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: restored.url } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('the restored data works through the real app as a restricted role: sign-in, own data, and tenant isolation', async () => {
    restoredRole = await createRestrictedAppPool(restored);
    await assertRestrictedRole(restoredRole.pool);
    restoredApi = await startApp(restoredRole.pool);
    const login = async (email) => {
      const result = await restoredApi.call('POST', '/api/auth/token', { body: { email, password: PASSWORD, deviceName: 'restore-check' } });
      assert.equal(result.status, 200, result.text);
      return result.body.accessToken;
    };
    const ownerToken = await login(owner.email);
    const otherToken = await login(other.email);
    for (const p of [`/api/orders/${ids.order}`, `/api/invoices/${ids.invoice}`, `/api/customers/${ids.customer}`]) {
      assert.equal((await restoredApi.call('GET', p, { token: ownerToken })).status, 200, p);
      assert.equal((await restoredApi.call('GET', p, { token: otherToken })).status, 404, `${p} must stay invisible to the other business`);
    }
    assert.equal((await restoredApi.call('GET', `/api/customers/${ids.otherCustomer}`, { token: ownerToken })).status, 404);
    assert.equal((await restoredApi.call('GET', `/api/customers/${ids.otherCustomer}`, { token: otherToken })).status, 200);
    assert.equal((await restoredApi.call('GET', '/api/orders')).status, 401);
  });

  it('the restore script refuses a database that already has tables', () => {
    const result = run('bash', [RESTORE_SCRIPT], { env: { ...process.env, BACKUP_FILE: dumpFile, RESTORE_TEST_DATABASE_URL: restored.url } });
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /not empty/);
  });

  it('the restore script rejects an empty file and a file that is not a backup, before touching the target', async () => {
    const empty = path.join(tmp, 'empty.dump');
    const garbage = path.join(tmp, 'garbage.dump');
    writeFileSync(empty, '');
    writeFileSync(garbage, 'this is not a pg_dump archive');
    const scratch = await createTempDatabase(url, 'avzar_bk_bad');
    try {
      const emptyRun = run('bash', [RESTORE_SCRIPT], { env: { ...process.env, BACKUP_FILE: empty, RESTORE_TEST_DATABASE_URL: scratch.url } });
      assert.equal(emptyRun.status, 2, emptyRun.stderr);
      const garbageRun = run('bash', [RESTORE_SCRIPT], { env: { ...process.env, BACKUP_FILE: garbage, RESTORE_TEST_DATABASE_URL: scratch.url } });
      assert.notEqual(garbageRun.status, 0, 'a file that is not a backup must not restore');
      const tables = (await scratch.pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'`)).rows[0].n;
      assert.equal(tables, 0, 'a rejected backup must leave the target database empty');
    } finally {
      await scratch.drop();
    }
  });
});
