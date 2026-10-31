import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};
const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000003';
const orderId = '00000000-0000-4000-8000-000000000050';

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* empty or plain text */ }
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const bearer = () => issueAccessToken({
  jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
}, { userId, businessId, sessionId }).token;
const staff = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };

/**
 * A pool whose only member has the given permissions. `order` is what the confirm transaction's order lookup returns
 * (null means no row, for example because the order belongs to another business).
 */
function poolWith(permissions, order = null) {
  const seen = [];
  const client = {
    query: async (sql, values) => {
      seen.push({ sql, values });
      if (sql.includes('FROM "Orders" o') && sql.includes('FOR UPDATE')) return { rows: order ? [order] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    seen,
    query: async (sql) => {
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: userId, BusinessId: businessId, Email: 'a@example.test', FullName: 'A', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: permissions }] };
      return { rows: [] };
    },
    connect: async () => client,
  };
}

const confirm = (pool, id = orderId) => requestApp(createApp(env, pool), `/api/orders/${id}/confirm`, { method: 'POST', headers: staff, body: '{}' });
const updates = (pool) => pool.seen.filter((call) => /UPDATE "Orders"/.test(call.sql));

describe('POST /api/orders/:id/confirm (converting a quotation into an order)', () => {
  it('rejects a user who has orders.manage and orders.view but not orders.confirm, without touching the database', async () => {
    const pool = poolWith(['orders.view', 'orders.manage', 'locations.all']);
    const response = await confirm(pool);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden');
    assert.equal(pool.seen.length, 0);
  });

  it('rejects a malformed order id with 400 for a user who may confirm', async () => {
    const response = await confirm(poolWith(['orders.confirm', 'locations.all']), 'not-a-uuid');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_order_id');
  });

  it('answers 404 when the order is not in the caller\'s business, and changes nothing', async () => {
    const pool = poolWith(['orders.confirm', 'locations.all'], null);
    const response = await confirm(pool);
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'order_not_found');
    assert.equal(updates(pool).length, 0);
    // The lookup is scoped to the caller's business.
    const lookup = pool.seen.find((call) => call.sql.includes('FOR UPDATE'));
    assert.equal(lookup.values[0], businessId);
  });

  it('refuses an order that is not Quoted (409) and changes nothing', async () => {
    for (const status of ['Draft', 'Confirmed', 'InProduction', 'Delivered', 'Cancelled']) {
      const pool = poolWith(['orders.confirm', 'locations.all'], { Status: status, PromisedDate: '2999-01-01', CustomerId: userId, CustomerStatus: 'Active', Today: '2026-10-20' });
      const response = await confirm(pool);
      assert.equal(response.status, 409, status);
      assert.equal(response.body.code, 'invalid_transition', status);
      assert.equal(updates(pool).length, 0, status);
    }
  });

  it('refuses a quoted order without approval of the current quotation version (409) and changes nothing', async () => {
    const pool = poolWith(['orders.confirm', 'locations.all'], {
      Status: 'Quoted', QuotedAtUtc: '2026-10-20T12:00:00.000Z', PromisedDate: '2999-01-01',
      CustomerId: userId, CustomerStatus: 'Active', Today: '2026-10-20',
    });
    const response = await confirm(pool);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'quotation_not_approved');
    assert.equal(updates(pool).length, 0);
    const approvalLookup = pool.seen.find((call) => call.sql.includes('FROM "QuotationEvents"'));
    assert.ok(approvalLookup, 'must verify an approval event');
    assert.deepEqual(approvalLookup.values, [businessId, orderId, '2026-10-20T12:00:00.000Z']);
    assert.match(approvalLookup.sql, /"Type" = 'Approved'/);
  });

  it('refuses a quoted order whose promised date has passed (400) and changes nothing', async () => {
    const pool = poolWith(['orders.confirm', 'locations.all'], { Status: 'Quoted', PromisedDate: '2026-10-01', CustomerId: userId, CustomerStatus: 'Active', Today: '2026-10-20' });
    const response = await confirm(pool);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'promised_date_passed');
    assert.equal(updates(pool).length, 0);
  });

  it('refuses a quoted order whose customer is not active (409) and changes nothing', async () => {
    const pool = poolWith(['orders.confirm', 'locations.all'], { Status: 'Quoted', PromisedDate: '2999-01-01', CustomerId: userId, CustomerStatus: 'Archived', Today: '2026-10-20' });
    const response = await confirm(pool);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'customer_not_active');
    assert.equal(updates(pool).length, 0);
  });
});
