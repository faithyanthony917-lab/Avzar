import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { newCsrfToken } from '../src/security/csrf.js';
import { computeCode, decodeBase32, encodeBase32, findStep, stepAt } from '../src/security/totp.js';
import { accountTokenKey, issueAccountToken, verifyAccountToken, PURPOSE_CONFIRM_EMAIL, PURPOSE_RESET_PASSWORD } from '../src/security/accountTokens.js';

const KEY = 'test-signing-key-with-at-least-thirty-two-characters';
const env = { NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: KEY, JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10 };
const ME = { userId: '00000000-0000-4000-8000-000000000001', businessId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
const OTHER_SESSION = '00000000-0000-4000-8000-000000000009';
const csrfHeaders = () => {
  const token = newCsrfToken(KEY);
  return { cookie: `tailoring.csrf=${token}`, 'x-xsrf-token': token, 'content-type': 'application/json' };
};

async function call(app, path, init = {}) {
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
    const text = await res.text();
    let body = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  } finally { await new Promise((r) => server.close(r)); }
}
const bearer = () => ({ authorization: `Bearer ${issueAccessToken({ jwtSigningKey: KEY, jwtIssuer: 'avzar-api', jwtAudience: 'avzar-mobile', accessTokenMinutes: 10 }, ME).token}`, 'content-type': 'application/json' });

// Minimal fake pool: records statements, answers the auth-guard queries, delegates the rest to `handler`.
function fakePool(handler) {
  const log = [];
  const answer = async (sql, values = []) => {
    log.push({ sql, values });
    if (sql.includes('FROM "UserSessions" WHERE "Id" = $1 AND "UserId" = $2 AND "RevokedAtUtc" IS NULL')) return { rows: [{ x: 1 }] };
    if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) return { rows: [{ UserId: ME.userId, Email: 'a@b.test', FullName: 'A', BusinessId: ME.businessId, BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: [] }] };
    return (await handler(sql, values)) ?? { rows: [], rowCount: 0 };
  };
  return { log, query: answer, connect: async () => ({ query: answer, release() {} }) };
}

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const key = Buffer.from('12345678901234567890');
    assert.equal(computeCode(key, 1), '287082'); // T = 59 s
    assert.equal(computeCode(key, 37037036), '081804'); // T = 1111111109 s
  });
  it('round-trips base32 and accepts +/-2 steps but not 3', () => {
    const key = Buffer.from('0123456789abcdef0123');
    assert.deepEqual(decodeBase32(encodeBase32(key)), key);
    const now = new Date(1_700_000_000_000); const step = stepAt(now);
    assert.equal(findStep(key, computeCode(key, step + 2), now), step + 2);
    assert.equal(findStep(key, computeCode(key, step + 3), now), null);
    assert.equal(findStep(key, 'abcdef', now), null);
  });
});

describe('account tokens', () => {
  const user = { Id: ME.userId, Email: 'a@b.test', SecurityStamp: 's1', PasswordHash: 'h1' };
  const key = accountTokenKey({ JWT_SIGNING_KEY: KEY });
  it('verifies, expires, and is bound to purpose and user state', () => {
    const now = new Date();
    const t = issueAccountToken(key, user, PURPOSE_RESET_PASSWORD, 60, now);
    assert.equal(verifyAccountToken(key, user, PURPOSE_RESET_PASSWORD, t, now), true);
    assert.equal(verifyAccountToken(key, user, PURPOSE_CONFIRM_EMAIL, t, now), false, 'wrong purpose');
    assert.equal(verifyAccountToken(key, { ...user, PasswordHash: 'h2' }, PURPOSE_RESET_PASSWORD, t, now), false, 'single use after password change');
    assert.equal(verifyAccountToken(key, user, PURPOSE_RESET_PASSWORD, t, new Date(now.getTime() + 61_000)), false, 'expired');
    assert.equal(verifyAccountToken(key, user, PURPOSE_RESET_PASSWORD, `${t}x`, now), false, 'tampered');
    assert.equal(verifyAccountToken(key, { ...user, Id: 'other' }, PURPOSE_RESET_PASSWORD, t, now), false, 'other user');
  });
  it('is unavailable without a long enough key', () => assert.equal(accountTokenKey({ JWT_SIGNING_KEY: 'short' }), null));
});

describe('account endpoints', () => {
  it('rejects unauthenticated access to every signed-in route', async () => {
    const app = createApp(env, fakePool(() => null));
    for (const [method, path] of [['GET', '/api/account/security'], ['GET', '/api/account/sessions'], ['GET', '/api/account/export'], ['POST', '/api/account/sessions/revoke-all'], ['POST', '/api/account/delete'], ['POST', '/api/account/two-factor/setup'], ['POST', '/api/account/resend-verification']]) {
      const res = await call(app, path, { method, headers: csrfHeaders(), body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it('lists only the caller\'s sessions (query is scoped by the token user id)', async () => {
    const pool = fakePool((sql) => (sql.includes('"DeviceName"') ? { rows: [{ Id: OTHER_SESSION, DeviceName: 'Pixel', CreatedAtUtc: 'c', LastUsedAtUtc: 'l', IdleExpiresAtUtc: 'e' }] } : null));
    const res = await call(createApp(env, pool), '/api/account/sessions', { headers: bearer() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body[0], { id: OTHER_SESSION, deviceName: 'Pixel', createdAtUtc: 'c', lastUsedAtUtc: 'l', expiresAtUtc: 'e' });
    const q = pool.log.find((l) => l.sql.includes('"DeviceName"'));
    assert.deepEqual(q.values, [ME.userId]);
  });

  it('treats another user\'s session id like a missing one (404) and rejects non-GUIDs', async () => {
    const pool = fakePool(() => ({ rows: [], rowCount: 0 }));
    const app = createApp(env, pool);
    assert.equal((await call(app, `/api/account/sessions/${OTHER_SESSION}`, { method: 'DELETE', headers: bearer() })).status, 404);
    assert.equal((await call(app, '/api/account/sessions/not-a-guid', { method: 'DELETE', headers: bearer() })).status, 404);
    const q = pool.log.find((l) => l.sql.startsWith('\n') === false && l.sql.includes('FROM "UserSessions" WHERE "Id" = $1 AND "UserId" = $2') && !l.sql.includes('RevokedAtUtc" IS NULL AND'));
    assert.deepEqual(q.values, [OTHER_SESSION, ME.userId]);
  });

  it('validates two-factor enable input', async () => {
    const res = await call(createApp(env, fakePool(() => null)), '/api/account/two-factor/enable', { method: 'POST', headers: bearer(), body: JSON.stringify({ code: '1' }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'validation_failed');
  });

  it('refuses to delete an account that owns a business, and never reaches the anonymising update', async () => {
    const { hashPassword } = await import('../src/security/passwordHasher.js');
    const hash = await hashPassword('correct horse battery');
    const pool = fakePool((sql) => {
      if (sql.includes('FROM "AspNetUsers" WHERE "Id" = $1')) return { rows: [{ Id: ME.userId, Email: 'a@b.test', FullName: 'A', EmailConfirmed: true, TwoFactorEnabled: false, PasswordHash: hash, SecurityStamp: 's', Deleted: false }] };
      if (sql.includes('"IsOwner" AND "Status" = 0')) return { rows: [{ x: 1 }] };
      return null;
    });
    const res = await call(createApp(env, pool), '/api/account/delete', { method: 'POST', headers: bearer(), body: JSON.stringify({ password: 'correct horse battery' }) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'owner_of_business');
    assert.ok(!pool.log.some((l) => l.sql.includes("'Deleted user'")));
  });

  it('reset-password rejects a bad token with invalid_token and does not touch the password', async () => {
    const pool = fakePool((sql) => (sql.includes('FROM "AspNetUsers" WHERE "Id" = $1') ? { rows: [{ Id: ME.userId, Email: 'a@b.test', SecurityStamp: 's', PasswordHash: 'h', Deleted: false }] } : null));
    const res = await call(createApp(env, pool), '/api/auth/reset-password', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ userId: ME.userId, token: 'bogus', newPassword: 'a-long-enough-password' }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_token');
    assert.ok(!pool.log.some((l) => l.sql.includes('SET "PasswordHash"')));
  });

  it('forgot-password answers 202 for unknown addresses and queues nothing', async () => {
    const pool = fakePool(() => ({ rows: [], rowCount: 0 }));
    const res = await call(createApp(env, pool), '/api/auth/forgot-password', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ email: 'nobody@example.test' }) });
    assert.equal(res.status, 202);
    assert.ok(!pool.log.some((l) => l.sql.includes('INSERT INTO "EmailOutbox"')));
  });

  it('forgot-password queues one reset email for a real account', async () => {
    const pool = fakePool((sql) => (sql.includes('"NormalizedEmail" = $1') ? { rows: [{ Id: ME.userId, Email: 'a@b.test', FullName: 'A', SecurityStamp: 's', PasswordHash: 'h', Deleted: false }] } : null));
    const res = await call(createApp(env, pool), '/api/auth/forgot-password', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ email: 'A@B.test' }) });
    assert.equal(res.status, 202);
    const inserts = pool.log.filter((l) => l.sql.includes('INSERT INTO "EmailOutbox"'));
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].values[4], /\/reset-password\?userId=/);
  });
});
