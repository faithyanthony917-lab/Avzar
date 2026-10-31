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

describe('staff access', () => {
  it('rejects staff list access without staff.view permission', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        return { rows: [] };
      },
    };

    const response = await requestApp(createApp(env, pool), '/api/staff', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden');
  });

  it('allows staff.view to list staff and role definitions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['staff.view', 'roles.manage', 'locations.manage'] }] };
        if (sql.includes('FROM "Memberships" m')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000010', UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Status: 0, FullName: 'Owner' }] };
        if (sql.includes('FROM "Roles"')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000020', Name: 'Owner', PermissionCount: 1 }] };
        return { rows: [] };
      },
    };

    const staff = await requestApp(createApp(env, pool), '/api/staff', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(staff.status, 200);
    assert.equal(Array.isArray(staff.body), true);

    const roles = await requestApp(createApp(env, pool), '/api/roles', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(roles.status, 200);
    assert.equal(Array.isArray(roles.body), true);

    const locations = await requestApp(createApp(env, pool), '/api/locations', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(locations.status, 200);
    assert.equal(Array.isArray(locations.body), true);
  });

  it('allows staff management and role writes with the correct permission', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('SELECT 1 FROM "Memberships" m JOIN "AspNetUsers" u')) return { rows: [] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['staff.view', 'staff.manage', 'roles.manage', 'locations.manage', 'audit.view'] }] };
        if (sql.includes('FROM "BusinessRoles"') && sql.includes('ANY')) return { rows: (values[1] ?? []).map((Id) => ({ Id, Name: 'Tailor', IsSystem: false })) };
        return { rows: [] };
      },
      connect: async () => ({
        query: async (sql, values = []) => {
          if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
          if (sql.includes('COALESCE(override."Value"')) return { rows: [{ Value: '10' }] };
          if (sql.includes('count(*)::int AS "Count" FROM "Memberships"')) return { rows: [{ Count: 1 }] };
          if (sql.includes('count(*)::int AS "Count" FROM "Invitations"')) return { rows: [{ Count: 0 }] };
          if (sql.includes('FROM "BusinessRoles" WHERE "BusinessId" = $1 AND lower')) return { rows: [] };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      }),
    };

    const invitation = await requestApp(createApp(env, pool), '/api/staff/invitations', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new-staff@example.test', fullName: 'New Staff', roleIds: ['00000000-0000-4000-8000-000000000010'], locationIds: [] }),
    });
    assert.equal(invitation.status, 201);
    assert.equal(invitation.body.email, 'new-staff@example.test');

    const createRole = await requestApp(createApp(env, pool), '/api/roles', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tailor', permissions: ['orders.view', 'tasks.manage'] }),
    });
    assert.equal(createRole.status, 201);
    assert.equal(createRole.body.name, 'Tailor');

    const createLocation = await requestApp(createApp(env, pool), '/api/locations', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Main Studio', address: '1 Market Road' }),
    });
    assert.equal(createLocation.status, 201);
    assert.equal(createLocation.body.name, 'Main Studio');

    const audit = await requestApp(createApp(env, pool), '/api/audit', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(audit.status, 200);
    assert.equal(Array.isArray(audit.body.items), true);
    assert.equal(audit.body.page, 1);
  });
});
