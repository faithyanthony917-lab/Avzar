import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTenantRlsBusinessId, installTenantRlsContext, runWithTenantRlsContext } from '../src/db/tenantRlsContext.js';
import { forEachUserBusiness, useBusiness, userBusinessIds, withUserLookup } from '../src/db/userScope.js';

const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function fakePool() {
  const calls = [];
  const makeClient = () => ({
    async query(sql, values) {
      const text = String(sql);
      calls.push({ sql: text, values });
      if (text.startsWith('SELECT DISTINCT "BusinessId"')) return { rows: [{ BusinessId: A }, { BusinessId: B }], rowCount: 2 };
      if (text.includes('current_setting')) return { rows: [{ value: A }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  });
  return { calls, async query(sql, values) { calls.push({ sql: String(sql), values }); return { rows: [], rowCount: 0 }; }, async connect() { return makeClient(); } };
}
const lookupKeys = (calls) => calls.filter((c) => c.sql.includes('unnest($1::text[]')).flatMap((c) => c.values[0]);

test('without the tenant wrapper the work runs once, with no business and no queries of its own', async () => {
  const pool = fakePool();
  const seen = [];
  const results = await forEachUserBusiness(pool, USER, async (_db, id) => { seen.push(id); return 'done'; });
  assert.deepEqual(results, ['done']);
  assert.deepEqual(seen, [null]);
  assert.equal(pool.calls.length, 0);
  useBusiness(pool, A);
  assert.equal(currentTenantRlsBusinessId(), null, 'no tenant is set for an unwrapped pool');
  assert.equal(await withUserLookup(pool, USER, async () => 'x'), 'x');
  assert.deepEqual(await userBusinessIds(pool, USER), []);
});

test('on a wrapped pool each business runs in its own context and the request context is untouched', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    useBusiness(pool, A);
    const seen = [];
    await forEachUserBusiness(pool, USER, async (_db, id) => { seen.push([id, currentTenantRlsBusinessId()]); });
    assert.deepEqual(seen, [[A, A], [B, B]]);
    assert.equal(currentTenantRlsBusinessId(), A, 'the request keeps its own business');
  });
  assert.ok(lookupKeys(pool.calls).includes('app.lookup_user_id'), 'the membership read carried the user key');
});

test('the user key is not left behind after the membership read', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    await withUserLookup(pool, USER, () => pool.query('SELECT 1'));
    await pool.query('SELECT 2');
  });
  const afterKey = pool.calls.filter((c) => c.sql === 'SELECT 2');
  assert.equal(afterKey.length, 1);
  assert.equal(pool.calls.filter((c) => c.sql.includes('unnest($1::text[]')).length, 1, 'only the first query carried the key');
});

test('inside a transaction the business is switched with transaction-local settings and restored', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    const seen = [];
    await forEachUserBusiness(client, USER, async (db, id) => { seen.push(id); await db.query('UPDATE "UserSessions" SET x = 1'); });
    await client.query('COMMIT');
    assert.deepEqual(seen, [A, B]);
  });
  const sets = pool.calls.filter((c) => c.sql.includes('set_config'));
  assert.deepEqual(sets.map((c) => (c.sql.includes('lookup_user_id') ? 'lookup' : 'business')), ['lookup', 'lookup', 'business', 'business', 'business']);
  assert.equal(sets[0].values[0], USER);
  assert.deepEqual(sets.slice(2).map((c) => c.values[0]), [A, B, A], 'each business in turn, then the previous one again');
});
