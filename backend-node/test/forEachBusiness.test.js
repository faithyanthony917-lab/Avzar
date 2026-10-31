import test from 'node:test';
import assert from 'node:assert/strict';
import { forEachBusiness, sumResults, withFreshTenantContext } from '../src/db/forEachBusiness.js';
import { currentTenantRlsBusinessId, installTenantRlsContext } from '../src/db/tenantRlsContext.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// A pool whose raw query lists the businesses and whose pooled client records the settings each query runs under.
function wrappedPool(ids = [A, B]) {
  const seen = [];
  const makeClient = () => {
    let settings = {};
    return {
      async query(sql, values) {
        const text = String(sql);
        if (/^\s*BEGIN/i.test(text) || /^\s*(COMMIT|ROLLBACK)/i.test(text)) { settings = {}; return { rows: [], rowCount: 0 }; }
        if (text.includes("set_config('app.business_id'")) { settings['app.business_id'] = values[0]; return { rows: [], rowCount: 0 }; }
        if (text.includes('unnest($1::text[]')) { values[0].forEach((key, i) => { settings[key] = values[1][i]; }); return { rows: [], rowCount: 0 }; }
        seen.push({ text, settings: { ...settings } });
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  };
  const pool = {
    seen,
    async query(sql) {
      if (String(sql).includes('"Businesses"')) return { rows: ids.map((Id) => ({ Id })), rowCount: ids.length };
      return { rows: [], rowCount: 0 };
    },
    async connect() { return makeClient(); },
  };
  return installTenantRlsContext(pool);
}

test('a pool without the tenant wrapper runs the work once, unscoped, without listing businesses', async () => {
  let listed = false;
  const pool = { async query() { listed = true; return { rows: [] }; } };
  const calls = [];
  const results = await forEachBusiness(pool, async (businessId) => { calls.push(businessId); return 7; }, { platform: true });
  assert.deepEqual(calls, [null]);
  assert.deepEqual(results, [7]);
  assert.equal(listed, false);
});

test('every business gets its own run, in its own tenant context, and the context does not outlive the run', async () => {
  const pool = wrappedPool([A, B, C]);
  const contexts = [];
  const results = await forEachBusiness(pool, async (businessId) => {
    contexts.push([businessId, currentTenantRlsBusinessId()]);
    await pool.query('SELECT 1 FROM "ProductionTasks"');
    return businessId;
  });
  assert.deepEqual(results, [A, B, C]);
  assert.deepEqual(contexts, [[A, A], [B, B], [C, C]]);
  assert.deepEqual(pool.seen.map((q) => q.settings['app.business_id']), [A, B, C]);
  assert.equal(currentTenantRlsBusinessId(), null);
});

test('the platform pass runs last, with no business and the platform scope on', async () => {
  const pool = wrappedPool([A]);
  await forEachBusiness(pool, async () => { await pool.query('SELECT 1 FROM "EmailOutbox"'); }, { platform: true });
  assert.equal(pool.seen.length, 2);
  assert.equal(pool.seen[0].settings['app.business_id'], A);
  assert.equal(pool.seen[0].settings['app.platform_scope'], undefined);
  assert.equal(pool.seen[1].settings['app.business_id'], undefined);
  assert.equal(pool.seen[1].settings['app.platform_scope'], 'on');
});

test('one failing business is logged and skipped; all failing rethrows the first error', async () => {
  const errors = [];
  const log = { error: (message, details) => errors.push({ message, details }) };
  const pool = wrappedPool([A, B]);
  const results = await forEachBusiness(pool, async (businessId) => {
    if (businessId === A) throw new Error('boom');
    return 'ok';
  }, { log });
  assert.deepEqual(results, ['ok']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].details.scope, A);
  assert.equal(JSON.stringify(errors[0]).includes('boom'), false);

  await assert.rejects(() => forEachBusiness(wrappedPool([A, B]), async () => { throw new RangeError('all'); }, { log }), /all/);
});

test('sumResults adds numbers and fields, concatenates arrays and ORs booleans', () => {
  assert.equal(sumResults([]), 0);
  assert.equal(sumResults([1, 2, 3]), 6);
  assert.deepEqual(sumResults([{ claimed: 1, events: ['a'], skipped: false }, { claimed: 2, events: ['b'], skipped: true }]), { claimed: 3, events: ['a', 'b'], skipped: true });
});

test('withFreshTenantContext keeps a bound tenant from leaking to the caller', async () => {
  const pool = wrappedPool();
  const { setTenantRlsContext } = await import('../src/db/tenantRlsContext.js');
  await withFreshTenantContext(pool, async () => { setTenantRlsContext(A); assert.equal(currentTenantRlsBusinessId(), A); });
  assert.equal(currentTenantRlsBusinessId(), null);
  assert.equal(await withFreshTenantContext({}, async () => 'plain'), 'plain');
});
