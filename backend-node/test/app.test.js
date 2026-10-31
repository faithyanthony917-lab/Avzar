import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const testEnv = { NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent' };

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

describe('Avzar PWA Node foundation', () => {
  it('does not trust forwarded headers unless explicit proxy CIDRs are configured', () => {
    assert.equal(createApp(testEnv).get('trust proxy'), false);

    const app = createApp({ ...testEnv, TRUSTED_PROXY_CIDRS: '127.0.0.1/8, 10.20.0.0/16' });
    const trustProxy = app.get('trust proxy fn');
    assert.equal(trustProxy('127.0.0.1', 0), true);
    assert.equal(trustProxy('10.20.4.5', 0), true);
    assert.equal(trustProxy('203.0.113.9', 0), false);
  });

  it('fails startup for an invalid trusted proxy range', () => {
    assert.throws(() => createApp({ ...testEnv, TRUSTED_PROXY_CIDRS: 'not-a-cidr' }));
  });

  it('exposes liveness and reports not ready when the database is not configured', async () => {
    const app = createApp(testEnv);
    const live = await requestApp(app, '/health/live');
    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'live');
    const ready = await requestApp(app, '/health/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'not_ready');
    assert.equal(ready.body.reason, 'database_not_configured');
  });

  it('reports ready only when Node can query PostgreSQL', async () => {
    let queried = false;
    const app = createApp(testEnv, { query: async (sql) => {
      queried = true;
      assert.equal(sql, 'SELECT 1');
      return { rows: [] };
    } });
    const ready = await requestApp(app, '/health/ready');
    assert.equal(queried, true);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');
    assert.equal(ready.body.database, 'healthy');
  });

  it('serves the C#-compatible /health path with the same database check as /health/ready', async () => {
    const ok = await requestApp(createApp(testEnv, { query: async () => ({ rows: [] }) }), '/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.database, 'healthy');
    const down = await requestApp(createApp(testEnv, { query: async () => { throw new Error('x'); } }), '/health');
    assert.equal(down.status, 503);
    assert.equal(down.body.reason, 'database_unavailable');
  });

  it('returns a safe 503 when the database is unavailable', async () => {
    const app = createApp(testEnv, { query: async () => { throw new Error('private connection detail'); } });
    const response = await requestApp(app, '/health/ready');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: 'not_ready', reason: 'database_unavailable' });
    assert.doesNotMatch(JSON.stringify(response.body), /private connection detail/);
  });

  it('is an API only: it serves no web shell and unknown paths are a JSON 404', async () => {
    const app = createApp(testEnv);
    for (const url of ['/', '/index.html', '/manifest.webmanifest', '/sw.js']) {
      const response = await requestApp(app, url);
      assert.equal(response.status, 404, url);
      assert.equal(response.body.code, 'not_found', url);
    }
  });

  it('does not forward unimplemented API functionality to the old service', async () => {
    const response = await requestApp(createApp(testEnv), '/backend/api/customers');
    assert.equal(response.status, 404);
  });

  it('validates mobile login input before querying the database', async () => {
    let queried = false;
    const env = { ...testEnv, JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10 };
    const app = createApp(env, { query: async () => { queried = true; return { rows: [] }; } });
    const response = await requestApp(app, '/api/auth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email', password: '' }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'validation_failed');
    assert.equal(queried, false);
  });

  it('resolves bearer users from the live session and active business membership', async () => {
    const env = { ...testEnv, JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10 };
    const identity = { userId: '00000000-0000-4000-8000-000000000001', businessId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
    const { token } = issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES }, identity);
    const calls = [];
    const pool = { query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      return { rows: [{ UserId: identity.userId, Email: 'owner@example.test', FullName: 'Owner', BusinessId: identity.businessId, BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
    } };
    const response = await requestApp(createApp(env, pool), '/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.body.businessId, identity.businessId);
    assert.deepEqual(response.body.permissions, ['customers.view']);
    assert.deepEqual(calls[0].values, [identity.sessionId, identity.userId]);
    assert.deepEqual(calls[1].values, [identity.userId, identity.businessId]);
  });

  it('rejects invalid bearer tokens without falling back to any cookie identity', async () => {
    let queried = false;
    const env = { ...testEnv, JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10 };
    const app = createApp(env, { query: async () => { queried = true; return { rows: [] }; } });
    const response = await requestApp(app, '/api/auth/me', { headers: { authorization: 'Bearer invalid', cookie: 'tailoring.session=forged' } });
    assert.equal(response.status, 401);
    assert.equal(queried, false);
  });
});
