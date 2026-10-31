import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { newCsrfToken } from '../src/security/csrf.js';
import { issueAccessToken } from '../src/security/jwt.js';

const env = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 8081, LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  CSRF_SIGNING_KEY: 'test-csrf-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
  REFRESH_IDLE_DAYS: 30, REFRESH_ABSOLUTE_DAYS: 90, MAX_SESSIONS_PER_USER: 10,
  ACCOUNT_TOKEN_KEY: 'test-account-token-key-with-at-least-thirty-two-characters',
};
const userId = '00000000-0000-4000-8000-000000000001';
const shopA = '00000000-0000-4000-8000-000000000002';
const shopB = '00000000-0000-4000-8000-000000000012';
const foreignShop = '00000000-0000-4000-8000-000000000099';
const sessionId = '00000000-0000-4000-8000-000000000003';

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* empty or plain text */ }
    return { status: response.status, body, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function jwtFor(business) {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId: business, sessionId }).token;
}

function cookieHeaders(business = shopA) {
  const csrf = newCsrfToken(env.CSRF_SIGNING_KEY);
  return {
    cookie: `tailoring.csrf=${csrf}; tailoring.session=${jwtFor(business)}`,
    'x-xsrf-token': csrf, 'content-type': 'application/json',
  };
}

/** The user is an active member of shopA and shopB only. Anything else is a business they do not belong to. */
function makePool() {
  const calls = [];
  const member = new Map([[shopA, { name: 'Alpha Tailors', owner: true }], [shopB, { name: 'Bravo Couture', owner: false }]]);

  async function query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('SELECT 1 FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Memberships" m') && sql.includes('JOIN "AspNetUsers" u')) {
      const biz = member.get(values[1]);
      if (!biz) return { rows: [] };
      return { rows: [{
        UserId: values[0], Email: 'owner@example.test', FullName: 'Owner', BusinessId: values[1], BusinessName: biz.name,
        TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: biz.owner, Permissions: [],
      }] };
    }
    if (sql.includes('FROM "Memberships" m JOIN "Businesses" b')) {
      return { rows: [...member].map(([id, biz]) => ({ BusinessId: id, BusinessName: biz.name, IsOwner: biz.owner })) };
    }
    if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: null }] };
    if (sql.includes('SELECT "Id" FROM "UserSessions"')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  }
  return { calls, query, connect: async () => ({ query, release() {} }) };
}

const sessionInserts = (pool) => pool.calls.filter((c) => c.sql.includes('INSERT INTO "UserSessions"'));
const revokes = (pool) => pool.calls.filter((c) => c.sql.includes("'business_switch'"));

describe('business switching', () => {
  it('lists only the signed-in user\'s active businesses and marks the current one', async () => {
    const pool = makePool();
    const res = await requestApp(createApp(env, pool), '/api/auth/businesses', { headers: { authorization: `Bearer ${jwtFor(shopA)}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.businesses.map((b) => [b.businessId, b.isCurrent, b.isOwner]), [[shopA, true, true], [shopB, false, false]]);
    const listQuery = pool.calls.find((c) => c.sql.includes('FROM "Memberships" m JOIN "Businesses" b'));
    assert.deepEqual(listQuery.values, [userId]);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('requires authentication to list businesses', async () => {
    const res = await requestApp(createApp(env, makePool()), '/api/auth/businesses');
    assert.equal(res.status, 401);
  });

  it('switches to another business: new cookie for that business, old session revoked, audit written', async () => {
    const pool = makePool();
    const res = await requestApp(createApp(env, pool), '/api/auth/switch-business', {
      method: 'POST', headers: cookieHeaders(shopA), body: JSON.stringify({ businessId: shopB }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.businessId, shopB);
    assert.equal(res.body.businessName, 'Bravo Couture');
    assert.match(res.headers.get('set-cookie'), /tailoring\.session=.*HttpOnly/);
    const inserts = sessionInserts(pool);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].values[2], shopB);
    assert.equal(revokes(pool).length, 1);
    assert.deepEqual(revokes(pool)[0].values, [sessionId, userId]);
    const audit = pool.calls.find((c) => c.sql.includes('INSERT INTO "AuditLogs"'));
    assert.equal(audit.values[1], 'auth.business_switched');
    assert.equal(audit.values[3], shopB);
  });

  it('refuses a business the user does not belong to and leaves the current session alone', async () => {
    const pool = makePool();
    const res = await requestApp(createApp(env, pool), '/api/auth/switch-business', {
      method: 'POST', headers: cookieHeaders(shopA), body: JSON.stringify({ businessId: foreignShop }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not_a_member');
    assert.equal(sessionInserts(pool).length, 0);
    assert.equal(revokes(pool).length, 0);
    assert.equal(pool.calls.some((c) => c.sql.includes('INSERT INTO "AuditLogs"')), false);
  });

  it('is a no-op when asked for the business already open', async () => {
    const pool = makePool();
    const res = await requestApp(createApp(env, pool), '/api/auth/switch-business', {
      method: 'POST', headers: cookieHeaders(shopA), body: JSON.stringify({ businessId: shopA }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.businessId, shopA);
    assert.equal(sessionInserts(pool).length, 0);
    assert.equal(revokes(pool).length, 0);
  });

  it('validates the body, requires CSRF, requires a session, and rejects non-browser sessions', async () => {
    const pool = makePool();
    const app = createApp(env, pool);
    const invalid = await requestApp(app, '/api/auth/switch-business', { method: 'POST', headers: cookieHeaders(), body: JSON.stringify({ businessId: 'not-a-uuid' }) });
    assert.equal(invalid.status, 400);
    const noCsrf = await requestApp(app, '/api/auth/switch-business', {
      method: 'POST', headers: { cookie: `tailoring.session=${jwtFor(shopA)}`, 'content-type': 'application/json' }, body: JSON.stringify({ businessId: shopB }),
    });
    assert.equal(noCsrf.status, 400);
    assert.equal(noCsrf.body.code, 'invalid_csrf');
    const csrf = newCsrfToken(env.CSRF_SIGNING_KEY);
    const anonymous = await requestApp(app, '/api/auth/switch-business', {
      method: 'POST', headers: { cookie: `tailoring.csrf=${csrf}`, 'x-xsrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ businessId: shopB }),
    });
    assert.equal(anonymous.status, 401);
    const bearer = await requestApp(app, '/api/auth/switch-business', {
      method: 'POST', headers: { authorization: `Bearer ${jwtFor(shopA)}`, 'content-type': 'application/json' }, body: JSON.stringify({ businessId: shopB }),
    });
    assert.equal(bearer.status, 400);
    assert.equal(bearer.body.code, 'browser_session_required');
    assert.equal(sessionInserts(pool).length, 0);
  });
});
