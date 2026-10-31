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
const quotationId = '00000000-0000-4000-8000-000000000060';

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

/** A pool whose only member has the given permissions. Any other statement returns no rows. */
function poolWith(permissions) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: userId, BusinessId: businessId, Email: 'a@example.test', FullName: 'A', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: permissions }] };
      return { rows: [] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  };
}
const staff = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
const json = { 'content-type': 'application/json' };

describe('quotation permissions', () => {
  it('needs orders.manage to send a quotation and orders.view to read its status', async () => {
    const viewOnly = poolWith(['orders.view']);
    const send = await requestApp(createApp(env, viewOnly), `/api/orders/${orderId}/quotation/send`, { method: 'POST', headers: staff, body: '{}' });
    assert.equal(send.status, 403);
    assert.equal(send.body.code, 'forbidden');

    const none = poolWith(['customers.view']);
    const status = await requestApp(createApp(env, none), `/api/orders/${orderId}/quotation`, { headers: staff });
    assert.equal(status.status, 403);
  });

  it('answers 404 for an order the pool cannot find and 400 for a malformed order id', async () => {
    const pool = poolWith(['orders.view', 'orders.manage']);
    const missing = await requestApp(createApp(env, pool), `/api/orders/${orderId}/quotation`, { headers: staff });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'order_not_found');
    const bad = await requestApp(createApp(env, pool), '/api/orders/not-a-uuid/quotation', { headers: staff });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_order_id');
  });
});

describe('customer portal quotation endpoints', () => {
  const app = () => createApp(env, poolWith([]));

  it('are reachable without a session or CSRF token and reject an invalid portal token', async () => {
    const list = await requestApp(app(), '/api/customer-portal/quotations', { method: 'POST', headers: json, body: JSON.stringify({ token: 'x'.repeat(40) }) });
    assert.equal(list.status, 401);
    assert.equal(list.body.code, 'portal_link_invalid');
    const respond = await requestApp(app(), '/api/customer-portal/quotations/respond', {
      method: 'POST', headers: json, body: JSON.stringify({ token: 'x'.repeat(40), orderId, quotationId, decision: 'approve' }),
    });
    assert.equal(respond.status, 401);
    assert.equal(respond.body.code, 'portal_link_invalid');
  });

  it('reject a token of the wrong length before touching the database', async () => {
    let queries = 0;
    const pool = { query: async () => { queries += 1; return { rows: [] }; }, connect: async () => ({ query: async () => { queries += 1; return { rows: [] }; }, release() {} }) };
    const result = await requestApp(createApp(env, pool), '/api/customer-portal/quotations', { method: 'POST', headers: json, body: JSON.stringify({ token: 'short' }) });
    assert.equal(result.status, 401);
    assert.equal(queries, 0);
  });

  it('validate the answer: decision, ids and note length', async () => {
    const base = { token: 'x'.repeat(40), orderId, quotationId };
    for (const body of [{ ...base, decision: 'maybe' }, { ...base, decision: 'approve', orderId: 'nope' }, { ...base, decision: 'decline', note: 'n'.repeat(501) }, { token: 'x'.repeat(40) }]) {
      const result = await requestApp(app(), '/api/customer-portal/quotations/respond', { method: 'POST', headers: json, body: JSON.stringify(body) });
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.code, 'validation_failed');
    }
  });
});
