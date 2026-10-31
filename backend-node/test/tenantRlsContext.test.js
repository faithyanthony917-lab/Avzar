import test from 'node:test';
import assert from 'node:assert/strict';
import { installTenantRlsContext, runWithTenantRlsContext, setTenantRlsContext } from '../src/db/tenantRlsContext.js';

const BUSINESS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fakePool() {
  const calls = [];
  const makeClient = () => ({
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      if (/^SELECT 1/.test(String(sql).trim())) return { rows: [{ ok: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  });
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql: String(sql), values, rawPool: true });
      return { rows: [], rowCount: 0 };
    },
    async connect() { return makeClient(); },
  };
}

test('tenant context is transaction-local for standalone pool queries', async () => {
  const pool = fakePool();
  installTenantRlsContext(pool);
  await runWithTenantRlsContext(async () => {
    setTenantRlsContext(BUSINESS_A);
    const result = await pool.query('SELECT 1');
    assert.equal(result.rowCount, 1);
  });
  assert.ok(pool.calls.some((x) => x.sql.includes("set_config('app.business_id', $1, true)") && x.values?.[0] === BUSINESS_A));
  assert.ok(pool.calls.some((x) => x.sql === 'BEGIN'));
  assert.ok(pool.calls.some((x) => x.sql === 'COMMIT'));
  assert.ok(!pool.calls.some((x) => x.rawPool));
});

test('missing tenant context does not set a tenant on a pooled query', async () => {
  const pool = fakePool();
  installTenantRlsContext(pool);
  await runWithTenantRlsContext(async () => {
    await pool.query('SELECT 1');
  });
  assert.ok(pool.calls.some((x) => x.rawPool));
  assert.ok(!pool.calls.some((x) => x.sql.includes('set_config')));
});

test('checked-out client binds tenant after BEGIN and clears transaction state after ROLLBACK', async () => {
  const pool = fakePool();
  installTenantRlsContext(pool);
  await runWithTenantRlsContext(async () => {
    setTenantRlsContext(BUSINESS_A);
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await client.query('ROLLBACK');
    client.release();
  });
  const setAt = pool.calls.findIndex((x) => x.sql.includes("set_config('app.business_id', $1, true)"));
  const beginAt = pool.calls.findIndex((x) => x.sql === 'BEGIN');
  const selectAt = pool.calls.findIndex((x) => x.sql === 'SELECT 1');
  assert.ok(beginAt >= 0 && setAt > beginAt && selectAt > setAt);
  assert.ok(pool.calls.some((x) => x.sql === 'ROLLBACK'));
});
