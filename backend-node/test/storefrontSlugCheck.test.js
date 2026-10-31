import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/http/errors.js';
import { installTenantRlsContext, runWithTenantRlsContext, setTenantRlsContext } from '../src/db/tenantRlsContext.js';
import { rethrowSlugTaken, slugTakenFrom, withStorefrontSlugVisible } from '../src/auth/storefrontSlugCheck.js';

const BUSINESS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fakePool() {
  const calls = [];
  const makeClient = () => ({
    async query(sql, values) { calls.push({ sql: String(sql), values }); return { rows: [], rowCount: 0 }; },
    release() {},
  });
  return { calls, async query(sql, values) { calls.push({ sql: String(sql), values, rawPool: true }); return { rows: [], rowCount: 0 }; }, async connect() { return makeClient(); } };
}
const isLookupSet = (c) => c.sql.includes('unnest($1::text[]');
const setsKey = (c, key, value) => c.sql.includes('set_config($1, $2, true)') && c.values?.[0] === key && c.values?.[1] === value;

test('the slug check sees the address under both lookup keys, then the keys are removed', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    setTenantRlsContext(BUSINESS_A);
    const client = await pool.connect();
    await client.query('BEGIN');
    const result = await withStorefrontSlugVisible(client, 'ra-shop', async () => { await client.query('SELECT 1 AS slug_check'); return 'checked'; });
    await client.query('COMMIT');
    assert.equal(result, 'checked');
    const texts = pool.calls.map((c) => c.sql);
    const check = texts.indexOf('SELECT 1 AS slug_check');
    const slugSet = pool.calls.findIndex((c) => setsKey(c, 'app.lookup_storefront_slug', 'ra-shop'));
    const redirectSet = pool.calls.findIndex((c) => setsKey(c, 'app.lookup_storefront_redirect_slug', 'ra-shop'));
    const reset = texts.findIndex((t) => t.includes("set_config('app.lookup_storefront_slug', '', true)"));
    assert.ok(slugSet >= 0 && redirectSet >= 0 && slugSet < check && redirectSet < check, 'both keys are set before the check');
    assert.ok(reset > check, 'both keys are reset after the check');
    // The request still belongs to its own business and carries no lookup key on later queries.
    await pool.query('SELECT 2');
    assert.ok(!pool.calls.some(isLookupSet));
  });
});

test('the slug keys are removed when the check throws', async () => {
  const pool = installTenantRlsContext(fakePool());
  await runWithTenantRlsContext(async () => {
    setTenantRlsContext(BUSINESS_A);
    const client = await pool.connect();
    await client.query('BEGIN');
    await assert.rejects(withStorefrontSlugVisible(client, 'ra-shop', async () => { throw new Error('boom'); }), /boom/);
    await pool.query('SELECT 2');
    assert.ok(!pool.calls.some(isLookupSet));
  });
});

test('a client without the tenant wrapper just runs the check', async () => {
  const plain = { query: async () => { throw new Error('no query expected'); } };
  assert.equal(await withStorefrontSlugVisible(plain, 'ra-shop', async () => 7), 7);
});

test('a unique violation on a storefront address becomes slug_taken; anything else is left alone', () => {
  for (const constraint of ['IX_Storefronts_Slug', 'PK_StorefrontSlugRedirects']) {
    const mapped = slugTakenFrom({ code: '23505', constraint });
    assert.ok(mapped instanceof AppError);
    assert.equal(mapped.status, 409);
    assert.equal(mapped.code, 'slug_taken');
  }
  assert.equal(slugTakenFrom({ code: '23505', constraint: 'IX_Designs_BusinessId_Slug' }), null);
  assert.equal(slugTakenFrom({ code: '23503', constraint: 'IX_Storefronts_Slug' }), null);
  assert.equal(slugTakenFrom(null), null);
  assert.throws(() => rethrowSlugTaken({ code: '23505', constraint: 'IX_Storefronts_Slug' }), (e) => e.code === 'slug_taken');
  const other = new Error('other');
  assert.throws(() => rethrowSlugTaken(other), (e) => e === other);
});
