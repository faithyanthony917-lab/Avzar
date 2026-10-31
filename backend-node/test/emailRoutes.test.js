import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { parseSecret, sign } from '../src/email/svix.js';

const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
  EMAIL_RESEND_WEBHOOK_SECRET: secret, PLATFORM_ADMIN_EMAILS: 'admin@example.test',
};
const identity = {
  userId: '00000000-0000-4000-8000-000000000001',
  businessId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
};
const token = issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER,
  jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES }, identity).token;

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* Non-JSON error bodies remain strings. */ }
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function fakePool({ email = 'admin@example.test', suppressions = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships" m')) return { rows: [{
        UserId: identity.userId, Email: email, FullName: 'Admin', BusinessId: identity.businessId,
        BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: [],
      }] };
      if (sql.includes('FROM "EmailSuppressions"')) return { rows: suppressions };
      if (sql.includes('INSERT INTO "EmailSuppressions"')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE "EmailOutbox"')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function signedHeaders(body, { signatureSecret = secret, eventId = 'evt_http_1' } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(parseSecret(signatureSecret), eventId, timestamp, body);
  return { 'content-type': 'application/json', 'svix-id': eventId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
}

describe('email routes', () => {
  it('accepts a correctly signed exact raw body without CSRF and applies the webhook event', async () => {
    const pool = fakePool();
    const body = '{ "type" : "email.delivered", "data" : { "email_id" : "resend-42" } }';
    const response = await requestApp(createApp(env, pool), '/api/webhooks/email/resend', {
      method: 'POST', headers: signedHeaders(body), body,
    });
    assert.equal(response.status, 200);
    assert.ok(pool.calls.some(({ sql, values }) => sql.includes('UPDATE "EmailOutbox"') && values[0] === 'resend-42'));
  });

  it('returns 404 when webhook verification is disabled and 401 for a bad signature', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-43' } });
    const disabled = await requestApp(createApp({ ...env, EMAIL_RESEND_WEBHOOK_SECRET: '' }), '/api/webhooks/email/resend', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(disabled.status, 404);

    const headers = signedHeaders(body);
    headers['svix-signature'] = 'v1,invalid';
    const pool = fakePool();
    const invalid = await requestApp(createApp(env, pool), '/api/webhooks/email/resend', { method: 'POST', headers, body });
    assert.equal(invalid.status, 401);
    assert.equal(pool.calls.length, 0);
  });

  it('rejects webhook bodies over 64 KiB with 413', async () => {
    const body = `${' '.repeat(65 * 1024)}{}`;
    const response = await requestApp(createApp(env, fakePool()), '/api/webhooks/email/resend', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.code, 'payload_too_large');
  });

  it('lists suppressions only for configured platform admins and preserves filter/limit response shape', async () => {
    const createdAtUtc = new Date('2026-10-18T12:00:00.000Z');
    const pool = fakePool({ suppressions: [{ Id: 'suppression-1', Address: 'ada@example.test', Reason: 'Complained', CreatedAtUtc: createdAtUtc }] });
    const admin = await requestApp(createApp(env, pool), '/api/platform-admin/email-suppressions?q=%20ADA%20&limit=999', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body, { items: [{ id: 'suppression-1', address: 'ada@example.test', reason: 'Complained', createdAtUtc: createdAtUtc.toISOString() }], limit: 500 });
    const query = pool.calls.find(({ sql }) => sql.includes('FROM "EmailSuppressions"'));
    assert.deepEqual(query.values, ['ada', 500]);

    const deniedPool = fakePool({ email: 'owner@example.test' });
    const denied = await requestApp(createApp(env, deniedPool), '/api/platform-admin/email-suppressions', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'platform_admin_required');
    assert.equal(deniedPool.calls.some(({ sql }) => sql.includes('FROM "EmailSuppressions"')), false);
  });
});