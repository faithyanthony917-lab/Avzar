import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adoptTenant, currentTenantRlsBusinessId, installTenantRlsContext, LOOKUP_KINDS, runWithTenantPlatformScope,
  runWithPlatformAdminRead, runWithTenantRlsContext, setTenantLookup,
} from '../src/db/tenantRlsContext.js';
import { bindTenantByLookup, TENANT_LOOKUPS } from '../src/db/tenantLookup.js';

const BUSINESS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakePool(rowsFor = () => []) {
  const calls = [];
  const makeClient = () => ({
    async query(sql, values) {
      const text = String(sql);
      calls.push({ sql: text, values });
      if (/^\s*SELECT "BusinessId"/.test(text)) return { rows: rowsFor(text, values), rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  });
  return {
    calls,
    async query(sql, values) { calls.push({ sql: String(sql), values, rawPool: true }); return { rows: [], rowCount: 0 }; },
    async connect() { return makeClient(); },
  };
}
const isLookupSet = (c) => c.sql.includes('unnest($1::text[]');

test('a lookup key scopes pool queries without setting a business', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    setTenantLookup('storefront_slug', 'sartoria');
    await pool.query('SELECT 1');
  });
  const order = pool.calls.map((c) => (isLookupSet(c) ? 'LOOKUP' : c.sql));
  assert.deepEqual(order, ['BEGIN', 'LOOKUP', 'SELECT 1', 'COMMIT', 'RELEASE']);
  const set = pool.calls.find(isLookupSet);
  assert.deepEqual(set.values, [['app.lookup_storefront_slug'], ['sartoria']]);
  assert.ok(!pool.calls.some((c) => c.sql.includes("'app.business_id'")));
  assert.ok(!pool.calls.some((c) => c.rawPool));
});

test('adoptTenant swaps the lookup for the business and drops the key', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    setTenantLookup('portal_token_hash', 'abc');
    adoptTenant(BUSINESS_A);
    assert.equal(currentTenantRlsBusinessId(), BUSINESS_A);
    await pool.query('SELECT 1');
  });
  assert.ok(pool.calls.some((c) => c.sql.includes("'app.business_id'") && c.values[0] === BUSINESS_A));
  assert.ok(!pool.calls.some(isLookupSet));
});

test('lookup keys do not leak between requests', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => { setTenantLookup('storefront_slug', 'one'); });
  await runWithTenantRlsContext(async () => { await pool.query('SELECT 1'); });
  assert.ok(pool.calls.every((c) => !c.sql.includes('set_config')));
});

test('unknown lookup keys throw and malformed uuid keys are ignored', async () => {
  await runWithTenantRlsContext(async () => {
    assert.throws(() => setTenantLookup('Slug"; DROP TABLE x; --', 'v'), TypeError);
    setTenantLookup('user_id', 'not-a-uuid');
    setTenantLookup('storefront_slug', '');
    const pool = installTenantRlsContext(fakePool());
    await pool.query('SELECT 1');
    assert.ok(pool.calls.every((c) => c.rawPool));
  });
});

test('platform scope is set per request and applies the setting on every query', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantPlatformScope(async () => { await pool.query('SELECT 1'); });
  const set = pool.calls.find(isLookupSet);
  assert.deepEqual(set.values, [['app.platform_scope'], ['on']]);
  await runWithTenantRlsContext(async () => { await pool.query('SELECT 2'); });
  assert.ok(pool.calls.filter(isLookupSet).length === 1);
});

test('a checked-out client applies lookup keys after BEGIN and accepts one mid-transaction', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    setTenantLookup('rtw_payment_reference', 'avzar_rtw_1');
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await setTenantLookup('storefront_slug', 'late', client);
    await adoptTenant(BUSINESS_A, client);
    await client.query('COMMIT');
    client.release();
  });
  const sqls = pool.calls.map((c) => (isLookupSet(c) ? 'LOOKUP' : c.sql));
  assert.deepEqual(sqls.slice(0, 3), ['BEGIN', 'LOOKUP', 'SELECT 1']);
  const lateSet = pool.calls.find((c) => c.values?.[0] === 'app.lookup_storefront_slug');
  assert.deepEqual(lateSet.values, ['app.lookup_storefront_slug', 'late']);
  assert.ok(pool.calls.some((c) => c.sql.includes("'app.business_id'") && c.values[0] === BUSINESS_A));
});

test('bindTenantByLookup adopts the business of the row it finds', async () => {
  const pool = installTenantRlsContext(fakePool((text, values) => (values[0] === 'sartoria' ? [{ BusinessId: BUSINESS_A }] : [])));
  await runWithTenantRlsContext(async () => {
    assert.equal(await bindTenantByLookup(pool, 'storefront_slug', 'sartoria'), BUSINESS_A);
    assert.equal(currentTenantRlsBusinessId(), BUSINESS_A);
  });
  const select = pool.calls.find((c) => c.sql.startsWith('SELECT "BusinessId" FROM "Storefronts"'));
  assert.deepEqual(select.values, ['sartoria']);
});

test('bindTenantByLookup returns null and sets no tenant when nothing matches', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    assert.equal(await bindTenantByLookup(pool, 'portal_token_hash', 'nope'), null);
    assert.equal(currentTenantRlsBusinessId(), null);
    await pool.query('SELECT 1');
  });
  assert.equal(pool.calls.filter(isLookupSet).length, 1, 'only the lookup query carries the key');
  await assert.rejects(() => bindTenantByLookup(pool, 'user_id', USER_ID), TypeError);
});

test('migration 0033 has one lookup policy per key and the platform-scope email policy', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  // 0033 holds the original keys; later migrations add a key together with the table it reads (0037: invoice_payment_reference).
  const sql = ['0033_tenant_lookup_policies.sql', '0037_invoice_online_payments.sql'].map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n');
  const policyKeys = [...sql.matchAll(/CREATE POLICY avzar_lookup_(\w+) ON "(\w+)" FOR SELECT/g)].map((m) => m[1]).sort();
  assert.deepEqual(policyKeys, Object.keys(LOOKUP_KINDS).sort());
  for (const key of Object.keys(LOOKUP_KINDS)) assert.ok(sql.includes(`app.lookup_${key}`), key);
  for (const [key, entry] of Object.entries(TENANT_LOOKUPS)) {
    assert.ok(Object.hasOwn(LOOKUP_KINDS, key), key);
    assert.ok(sql.includes(`ON "${entry.table}" FOR SELECT`), `${key} table`);
  }
  assert.ok(sql.includes('CREATE POLICY avzar_platform_scope_email ON "EmailOutbox" FOR ALL'));
});

test('bindTenantByLookup does nothing on a pool without the tenant wrapper (no row-level security to satisfy)', async () => {
  const pool = fakePool(() => [{ BusinessId: BUSINESS_A }]);
  await runWithTenantRlsContext(async () => {
    assert.equal(await bindTenantByLookup(pool, 'storefront_slug', 'sartoria'), null);
    assert.equal(currentTenantRlsBusinessId(), null);
  });
  assert.equal(pool.calls.length, 0);
});

test('bindTenantByLookup on a checked-out client binds the rest of that transaction', async () => {
  const pool = installTenantRlsContext(fakePool((text, values) => (values[0] === 'HASH' ? [{ BusinessId: BUSINESS_A }] : [])));
  await runWithTenantRlsContext(async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    assert.equal(await bindTenantByLookup(client, 'portal_token_hash', 'HASH'), BUSINESS_A);
    await client.query('SELECT 2');
    assert.equal(await bindTenantByLookup(client, 'portal_token_hash', 'OTHER'), null);
    await client.query('ROLLBACK');
    client.release();
  });
  const sqls = pool.calls.map((c) => c.sql);
  const key = pool.calls.findIndex((c) => c.values?.[0] === 'app.lookup_portal_token_hash' && c.values?.[1] === 'HASH');
  const select = sqls.findIndex((s) => s.startsWith('SELECT "BusinessId" FROM "CustomerPortalGrants"'));
  const business = pool.calls.findIndex((c) => c.sql.includes("'app.business_id'") && c.values?.[0] === BUSINESS_A);
  assert.ok(key >= 0 && select > key && business > select, 'key set, then lookup read, then business set');
  assert.ok(pool.calls.some((c) => c.values?.[0] === 'app.lookup_portal_token_hash' && c.values?.[1] === ''), 'a miss clears the key');
});

test('platform-admin read is its own setting, per request, and is not platform scope', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithPlatformAdminRead(async () => { await pool.query('SELECT 1'); });
  const set = pool.calls.find(isLookupSet);
  assert.deepEqual(set.values, [['app.platform_admin_read'], ['on']]);
  await runWithTenantRlsContext(async () => { await pool.query('SELECT 2'); });
  assert.equal(pool.calls.filter(isLookupSet).length, 1, 'the next request does not inherit it');
});

test('migration 0043 opens SELECT only, on exactly the five queue tables, behind the platform-admin setting', () => {
  const sql = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations/0043_platform_admin_read.sql'), 'utf8');
  for (const table of ['NotificationOutbox', 'PushDeliveries', 'WorkerSummaryJobs', 'AppointmentReminders', 'EmailOutbox']) assert.ok(sql.includes(`'${table}'`), table);
  assert.ok(sql.includes('FOR SELECT'));
  assert.ok(sql.includes("current_setting('app.platform_admin_read', true) = 'on'"));
  assert.doesNotMatch(sql, /FOR (ALL|INSERT|UPDATE|DELETE)/);
});
