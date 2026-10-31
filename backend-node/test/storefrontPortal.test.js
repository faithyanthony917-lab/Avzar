import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const env = {
  NODE_ENV: 'test',
  PORT: 8081,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api',
  JWT_AUDIENCE: 'avzar-mobile',
  ACCESS_TOKEN_MINUTES: 10,
  WEB_BASE_URL: 'https://app.example.test',
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function bearerToken(userId = '00000000-0000-4000-8000-000000000001', businessId = '00000000-0000-4000-8000-000000000002', sessionId = '00000000-0000-4000-8000-000000000003') {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId }).token;
}

function customerPortalPool({ permissions = ['customers.manage'], customerFound = true, accessGrant = true } = {}) {
  const statements = [];
  const userId = '00000000-0000-4000-8000-000000000001';
  const businessId = '00000000-0000-4000-8000-000000000002';
  const customerId = '00000000-0000-4000-8000-000000000004';
  const member = {
    UserId: userId,
    BusinessId: businessId,
    Email: 'owner@example.test',
    FullName: 'Owner',
    BusinessName: 'Shop',
    TimeZoneId: 'UTC',
    CurrencyCode: 'USD',
    IsOwner: false,
    Permissions: permissions,
  };
  const query = async (sql, values = []) => {
    statements.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [member] };
    if (sql.includes('FROM "Customers"') && sql.includes('"FullName"')) {
      return { rows: customerFound ? [{ Id: customerId, BusinessId: businessId, FullName: 'Jane Doe', Email: 'jane@example.test' }] : [] };
    }
    if (sql.includes('FROM "Businesses"')) return { rows: [{ Name: 'Shop' }] };
    if (sql.includes('FROM "Customers"')) return { rows: customerFound ? [{ Id: customerId }] : [] };
    return { rows: [], rowCount: 1 };
  };
  return {
    statements,
    query,
    async connect() {
      return {
        query: async (sql, values = []) => {
          statements.push({ sql, values });
          if (sql.includes('SELECT g."Id" AS "GrantId"')) {
            return { rows: accessGrant ? [{ GrantId: '00000000-0000-4000-8000-000000000005', BusinessId: businessId,
              CustomerId: customerId, CustomerName: 'Jane Doe', BusinessName: 'Shop', CurrencyCode: 'USD' }] : [] };
          }
          if (sql.startsWith('UPDATE "CustomerPortalGrants"')) return { rows: [], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
}

describe('storefront and portal', () => {
  it('rejects storefront and inquiry access without the required permissions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        return { rows: [] };
      },
    };

    const storefronts = await requestApp(createApp(env, pool), '/api/storefronts', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(storefronts.status, 403);
    assert.equal(storefronts.body.code, 'forbidden');

    const inquiries = await requestApp(createApp(env, pool), '/api/inquiries', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(inquiries.status, 403);
    assert.equal(inquiries.body.code, 'forbidden');
  });

  it('allows storefront lists and inquiry management reads with the right permissions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['storefront.view', 'storefront.edit', 'storefront.publish', 'inquiries.view', 'inquiries.manage'] }] };
        return { rows: [] };
      },
    };

    const storefronts = await requestApp(createApp(env, pool), '/api/storefronts', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(storefronts.status, 200);
    assert.equal(Array.isArray(storefronts.body), true);

    const inquiries = await requestApp(createApp(env, pool), '/api/inquiries', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(inquiries.status, 200);
    assert.deepEqual(inquiries.body, { items: [], page: 1, pageSize: 25, totalCount: 0 });
  });
});

describe('customer portal routes', () => {
  const customerId = '00000000-0000-4000-8000-000000000004';
  const authHeaders = { authorization: `Bearer ${bearerToken()}` };

  it('queues a hashed portal grant and email for a same-business customer', async () => {
    const pool = customerPortalPool();
    const result = await requestApp(createApp(env, pool), `/api/customer-portal/customers/${customerId}/link`, {
      method: 'POST', headers: authHeaders,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.maskedEmail, 'j***@example.test');
    assert.ok(Date.parse(result.body.expiresAtUtc) > Date.now());
    const grant = pool.statements.find(({ sql }) => sql.includes('INSERT INTO "CustomerPortalGrants"'));
    const mail = pool.statements.find(({ sql }) => sql.includes('INSERT INTO "EmailOutbox"'));
    assert.ok(grant);
    assert.ok(mail);
    assert.match(grant.values[3], /^[A-F0-9]{64}$/);
    assert.ok(!mail.values[4].includes(grant.values[3]));
    assert.match(mail.values[2], /customer-portal#/);
  });

  it('requires authentication and customers.manage for staff link operations', async () => {
    const unauthenticated = await requestApp(createApp(env, customerPortalPool()), `/api/customer-portal/customers/${customerId}/link`, {
      method: 'POST', headers: { authorization: 'Bearer invalid-token' },
    });
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(env, customerPortalPool({ permissions: ['customers.view'] })), `/api/customer-portal/customers/${customerId}/links`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(forbidden.status, 403);
  });

  it('hides customers in another business and validates portal access tokens', async () => {
    const pool = customerPortalPool({ customerFound: false });
    const crossBusiness = await requestApp(createApp(env, pool), `/api/customer-portal/customers/${customerId}/link`, {
      method: 'POST', headers: authHeaders,
    });
    assert.equal(crossBusiness.status, 404);

    const invalid = await requestApp(createApp(env, customerPortalPool()), '/api/customer-portal/access', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'short' }),
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.code, 'portal_link_invalid');
  });

  it('returns portal data only through an active grant and records grant use', async () => {
    const pool = customerPortalPool();
    const result = await requestApp(createApp(env, pool), '/api/customer-portal/access', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(43) }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { customerName: 'Jane Doe', businessName: 'Shop', currencyCode: 'USD', onlinePaymentsEnabled: false, orders: [], invoices: [] });
    assert.ok(pool.statements.some(({ sql }) => sql.includes('"UseCount" = "UseCount" + 1')));

    const expiredOrRevoked = await requestApp(createApp(env, customerPortalPool({ accessGrant: false })), '/api/customer-portal/access', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'b'.repeat(43) }),
    });
    assert.equal(expiredOrRevoked.status, 401);
  });

  it('revokes active links for the authenticated customer and returns no content', async () => {
    const pool = customerPortalPool();
    const result = await requestApp(createApp(env, pool), `/api/customer-portal/customers/${customerId}/links`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(result.status, 204);
    assert.ok(pool.statements.some(({ sql, values }) => sql.startsWith('UPDATE "CustomerPortalGrants"') && values[1] === '00000000-0000-4000-8000-000000000002'));
  });
});
