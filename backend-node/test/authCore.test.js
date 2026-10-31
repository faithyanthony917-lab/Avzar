import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { hashPassword } from '../src/security/passwordHasher.js';
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
const businessId = '00000000-0000-4000-8000-000000000002';
const otherBusinessId = '00000000-0000-4000-8000-000000000022';
const sessionId = '00000000-0000-4000-8000-000000000003';
const roleId = '00000000-0000-4000-8000-000000000004';
const locationId = '00000000-0000-4000-8000-000000000005';

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* Keep empty and plain-text responses unchanged. */ }
    return { status: response.status, body, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function csrfHeaders() {
  const token = newCsrfToken(env.CSRF_SIGNING_KEY);
  return { cookie: `tailoring.csrf=${token}`, 'x-xsrf-token': token, 'content-type': 'application/json' };
}

function tokenFor(business = businessId) {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId: business, sessionId }).token;
}

function makePool(options = {}) {
  const calls = [];
  const state = {
    user: options.user ?? null,
    choices: options.choices ?? [{ BusinessId: businessId, BusinessName: 'Shop' }],
    unavailableBusinesses: new Set(options.unavailableBusinesses ?? []),
    invitation: options.invitation ?? {
      Id: '00000000-0000-4000-8000-000000000006', BusinessId: businessId,
      Email: 'staff@example.test', FullName: 'Staff Member', RoleIds: [roleId], LocationIds: [locationId],
    },
    roleBusinessId: options.roleBusinessId ?? businessId,
    locationBusinessId: options.locationBusinessId ?? businessId,
    existingMembership: options.existingMembership ?? false,
  };

  async function query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('SELECT 1 FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Memberships" m') && sql.includes('JOIN "AspNetUsers" u')) {
      if (state.unavailableBusinesses.has(values[1])) return { rows: [] };
      return { rows: [{
        UserId: values[0], Email: state.user?.Email ?? 'owner@example.test', FullName: state.user?.FullName ?? 'Owner',
        BusinessId: values[1], BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD',
        IsOwner: true, Permissions: [],
      }] };
    }
    if (sql.includes('FROM "Memberships" m JOIN "Businesses" b')) return { rows: state.choices };
    if (sql.includes('FROM "AspNetUsers" WHERE "NormalizedEmail"')) {
      const normalized = values[0];
      return { rows: state.user && state.user.NormalizedEmail === normalized ? [state.user] : [] };
    }
    if (sql.includes('FROM "AspNetUsers" WHERE "Id" = $1')) {
      return { rows: state.user && state.user.Id === values[0] ? [{ ...state.user, Deleted: false }] : [] };
    }
    if (sql.includes('SELECT "Id" FROM "Plans" WHERE "Code"')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000007' }] };
    if (sql.includes('FROM "Invitations"') && sql.includes('"TokenHash"')) return { rows: [state.invitation] };
    if (sql.includes('FROM "BusinessRoles"')) {
      const ids = values[1] ?? [];
      return state.roleBusinessId === values[0] ? { rows: ids.includes(roleId) ? [{ Id: roleId }] : [] } : { rows: [] };
    }
    if (sql.includes('FROM "Locations"') && sql.includes('"Id" = ANY')) {
      const ids = values[1] ?? [];
      return state.locationBusinessId === values[0] ? { rows: ids.includes(locationId) ? [{ Id: locationId }] : [] } : { rows: [] };
    }
    if (sql.includes('SELECT COALESCE(override."Value"')) return { rows: [{ Value: '5' }] };
    if (sql.includes('SELECT count(*)::int AS "Count" FROM "Memberships"')) return { rows: [{ Count: 0 }] };
    if (sql.includes('SELECT 1 FROM "Memberships" WHERE')) return { rows: state.existingMembership ? [{ '?column?': 1 }] : [] };
    if (sql.includes('SELECT 1 FROM "EmailOutbox"')) return { rows: [] };
    if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: null }] };
    if (sql.includes('SELECT "Id" FROM "UserSessions"')) return { rows: [] };
    if (sql.includes('INSERT INTO "AspNetUsers"')) {
      state.user = {
        Id: values[0], SecurityStamp: values[1], Email: values[2], FullName: values[3],
        NormalizedEmail: values[4], PasswordHash: values[5], EmailConfirmed: sql.includes('TRUE,$4'),
        TwoFactorEnabled: false, LockoutEnabled: true, LockoutEnd: null, Deleted: false,
      };
    }
    return { rows: [], rowCount: 1 };
  }

  return {
    calls,
    query,
    connect: async () => ({ query, release() {} }),
  };
}

describe('core auth routes', () => {
  it('issues a signed CSRF token and cookie without authentication', async () => {
    const response = await requestApp(createApp(env), '/api/auth/csrf');
    assert.equal(response.status, 200);
    assert.equal(typeof response.body.token, 'string');
    assert.match(response.headers.get('set-cookie'), /tailoring\.csrf=.*HttpOnly/);
  });

  it('registers a business with defaults and signs in the owner', async () => {
    const pool = makePool();
    const response = await requestApp(createApp(env, pool), '/api/auth/register-business', {
      method: 'POST', headers: csrfHeaders(),
      body: JSON.stringify({ businessName: 'Tailor Shop', ownerName: 'Shop Owner', email: 'owner@example.test', password: 'a-valid-passphrase' }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.isOwner, true);
    assert.match(response.headers.get('set-cookie'), /tailoring\.session=.*HttpOnly/);
    assert.equal(pool.calls.filter((call) => call.sql.includes('INSERT INTO "MeasurementTemplates"')).length, 6);
    assert.equal(pool.calls.filter((call) => call.sql.includes('INSERT INTO "Stages"')).length, 10);
  });

  it('rejects invalid registration and missing CSRF before touching the database', async () => {
    const pool = makePool();
    const invalid = await requestApp(createApp(env, pool), '/api/auth/register-business', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ businessName: 'x' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'validation_failed');
    const csrf = await requestApp(createApp(env, pool), '/api/auth/register-business', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(csrf.status, 400);
    assert.equal(csrf.body.code, 'invalid_csrf');
  });

  it('authenticates a user and rejects a requested business outside their memberships', async () => {
    const passwordHash = await hashPassword('correct-horse-battery');
    const user = { Id: userId, Email: 'owner@example.test', NormalizedEmail: 'OWNER@EXAMPLE.TEST', FullName: 'Owner', PasswordHash: passwordHash, EmailConfirmed: true, TwoFactorEnabled: false, LockoutEnabled: true, LockoutEnd: null };
    const pool = makePool({ user });
    const success = await requestApp(createApp(env, pool), '/api/auth/login', {
      method: 'POST', headers: csrfHeaders(),
      body: JSON.stringify({ email: user.Email, password: 'correct-horse-battery' }),
    });
    assert.equal(success.status, 200);
    assert.equal(success.body.userId, userId);
    const sessionCookie = success.headers.get('set-cookie').split(';')[0];
    const current = await requestApp(createApp(env, pool), '/api/auth/me', { headers: { cookie: sessionCookie } });
    assert.equal(current.status, 200);

    const forbidden = await requestApp(createApp(env, makePool({ user })), '/api/auth/login', {
      method: 'POST', headers: csrfHeaders(),
      body: JSON.stringify({ email: user.Email, password: 'correct-horse-battery', businessId: otherBusinessId }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'not_a_member');
  });

  it('validates login requests and returns 401 for bad credentials', async () => {
    const user = { Id: userId, Email: 'owner@example.test', NormalizedEmail: 'OWNER@EXAMPLE.TEST', FullName: 'Owner', PasswordHash: await hashPassword('correct-horse-battery'), EmailConfirmed: true, TwoFactorEnabled: false, LockoutEnabled: true, LockoutEnd: null };
    const invalid = await requestApp(createApp(env, makePool({ user })), '/api/auth/login', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ email: 'not-an-email', password: '' }),
    });
    assert.equal(invalid.status, 400);
    const unauthorized = await requestApp(createApp(env, makePool({ user })), '/api/auth/login', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ email: user.Email, password: 'wrong-password' }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, 'invalid_credentials');
  });

  it('accepts a new invitation and rejects invited access from another business', async () => {
    const invalid = await requestApp(createApp(env, makePool()), '/api/auth/accept-invitation', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ token: 'invite-token' }),
    });
    assert.equal(invalid.status, 400);

    const pool = makePool();
    const accepted = await requestApp(createApp(env, pool), '/api/auth/accept-invitation', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ token: 'invite-token', password: 'a-valid-passphrase' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.businessId, businessId);
    assert.equal(pool.calls.some((call) => call.sql.includes('INSERT INTO "MembershipLocations"') && call.values[2] === businessId), true);

    const isolated = makePool({ roleBusinessId: otherBusinessId });
    const rejected = await requestApp(createApp(env, isolated), '/api/auth/accept-invitation', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ token: 'invite-token', password: 'a-valid-passphrase' }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'invalid_invitation');
    const roleCheck = isolated.calls.find((call) => call.sql.includes('FROM "BusinessRoles"'));
    assert.equal(roleCheck.values[0], businessId);

    const crossLocation = makePool({ locationBusinessId: otherBusinessId });
    const acceptedWithoutForeignLocation = await requestApp(createApp(env, crossLocation), '/api/auth/accept-invitation', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ token: 'invite-token', password: 'a-valid-passphrase' }),
    });
    assert.equal(acceptedWithoutForeignLocation.status, 200);
    assert.equal(crossLocation.calls.some((call) => call.sql.includes('INSERT INTO "MembershipLocations"')), false);
    const locationCheck = crossLocation.calls.find((call) => call.sql.includes('FROM "Locations"') && call.sql.includes('"Id" = ANY'));
    assert.equal(locationCheck.values[0], businessId);
  });

  it('requires authentication for accepting an existing-user invitation and denies email mismatches', async () => {
    const pool = makePool({ user: { Id: userId, Email: 'owner@example.test', NormalizedEmail: 'OWNER@EXAMPLE.TEST', FullName: 'Owner' } });
    const unauthenticated = await requestApp(createApp(env, pool), '/api/auth/accept-invitation/existing', {
      method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ token: 'invite-token' }),
    });
    assert.equal(unauthenticated.status, 401);

    const token = tokenFor();
    const invalid = await requestApp(createApp(env, pool), '/api/auth/accept-invitation/existing', {
      method: 'POST', headers: { ...csrfHeaders(), authorization: `Bearer ${token}` }, body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);

    const forbidden = await requestApp(createApp(env, pool), '/api/auth/accept-invitation/existing', {
      method: 'POST', headers: { ...csrfHeaders(), authorization: `Bearer ${token}` },
      body: JSON.stringify({ token: 'invite-token' }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'invitation_email_mismatch');
  });

  it('logs out an authenticated session and rejects unauthenticated logout', async () => {
    const pool = makePool();
    const logout = await requestApp(createApp(env, pool), '/api/auth/logout', {
      method: 'POST', headers: { authorization: `Bearer ${tokenFor()}` },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    const unauthenticated = await requestApp(createApp(env, pool), '/api/auth/logout', {
      method: 'POST', headers: csrfHeaders(),
    });
    assert.equal(unauthenticated.status, 401);
  });

  it('returns the current user only for an active membership in the token business', async () => {
    const pool = makePool({ unavailableBusinesses: [otherBusinessId] });
    const success = await requestApp(createApp(env, pool), '/api/auth/me', {
      headers: { authorization: `Bearer ${tokenFor()}` },
    });
    assert.equal(success.status, 200);
    const unauthenticated = await requestApp(createApp(env, pool), '/api/auth/me');
    assert.equal(unauthenticated.status, 401);
    const crossBusiness = await requestApp(createApp(env, pool), '/api/auth/me', {
      headers: { authorization: `Bearer ${tokenFor(otherBusinessId)}` },
    });
    assert.equal(crossBusiness.status, 401);
  });
});