import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { newCsrfToken } from '../src/security/csrf.js';

const testEnv = { NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent' };
const csrfHeaders = (secret) => {
  const token = newCsrfToken(secret);
  return { cookie: `tailoring.csrf=${token}`, 'x-xsrf-token': token, 'content-type': 'application/json' };
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* Static HTML and plain text remain strings. */ }
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('account routes', () => {
  it('accepts forgotten-password requests without revealing account existence', async () => {
    const secret = 'test-signing-key-with-at-least-thirty-two-characters';
    const app = createApp({ ...testEnv, JWT_SIGNING_KEY: secret });
    const response = await requestApp(app, '/api/auth/forgot-password', {
      method: 'POST',
      headers: csrfHeaders(secret),
      body: JSON.stringify({ email: 'user@example.test' }),
    });
    assert.equal(response.status, 202);
  });

  it('returns security metadata from the authenticated account session', async () => {
    const env = { ...testEnv, JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10 };
    const identity = { userId: '00000000-0000-4000-8000-000000000001', businessId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
    const { token } = issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES }, identity);
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "AspNetUsers" WHERE "Id" = $1')) return { rows: [{ Id: identity.userId, Email: 'owner@example.test', FullName: 'Owner', EmailConfirmed: true, TwoFactorEnabled: false, Deleted: false }] };
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) return { rows: [{ UserId: identity.userId, Email: 'owner@example.test', FullName: 'Owner', BusinessId: identity.businessId, BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        return { rows: [] };
      },
    };
    const response = await requestApp(createApp(env, pool), '/api/account/security', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.emailConfirmed, true);
    assert.equal(response.body.twoFactorEnabled, false);
    assert.equal(response.body.activeSessions, 1);
  });

  it('rejects invalid current passwords when changing credentials', async () => {
    const env = { ...testEnv, JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10 };
    const identity = { userId: '00000000-0000-4000-8000-000000000001', businessId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
    const { token } = issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES }, identity);
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) return { rows: [{ UserId: identity.userId, Email: 'owner@example.test', FullName: 'Owner', BusinessId: identity.businessId, BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        if (sql.includes('FROM "AspNetUsers" WHERE "Id" = $1')) return { rows: [{ Id: identity.userId, PasswordHash: '$argon2id$v=19$m=65536,t=3,p=1$abc$def' }] };
        return { rows: [] };
      },
    };
    const response = await requestApp(createApp(env, pool), '/api/account/change-password', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'newValidPassword123' }),
    });
    // Same contract as the C# AccountService: BadRequest("wrong_password").
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'wrong_password');
  });
});
