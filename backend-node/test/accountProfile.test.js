import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const KEY = 'test-signing-key-with-at-least-thirty-two-characters';
const env = { NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: KEY, JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10 };
const ME = { userId: '00000000-0000-4000-8000-000000000001', businessId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
const SOMEONE_ELSE = '00000000-0000-4000-8000-0000000000aa';
const bearer = () => ({
  authorization: `Bearer ${issueAccessToken({ jwtSigningKey: KEY, jwtIssuer: 'avzar-api', jwtAudience: 'avzar-mobile', accessTokenMinutes: 10 }, ME).token}`,
  'content-type': 'application/json',
});

async function call(app, path, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A pool that answers the sign-in checks and the profile queries, and records every statement it was asked to run. */
function fakePool({ phone = null } = {}) {
  const calls = [];
  const answer = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) {
      return { rows: [{ UserId: ME.userId, Email: 'owner@example.test', FullName: 'Owner', BusinessId: ME.businessId, BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
    }
    if (sql.includes('UPDATE "AspNetUsers"')) return { rows: [{ FullName: values[1], Email: 'owner@example.test', PhoneNumber: values[2] }] };
    if (sql.includes('SELECT "PhoneNumber" FROM "AspNetUsers"')) return { rows: [{ PhoneNumber: phone }] };
    if (sql.includes('FROM "AspNetUsers" WHERE "Id" = $1')) return { rows: [{ Id: ME.userId, Email: 'owner@example.test', FullName: 'Owner', Deleted: false }] };
    return { rows: [] };
  };
  return { calls, query: answer, connect: async () => ({ query: answer, release() {} }) };
}

const put = (pool, body) => call(createApp(env, pool), '/api/account/profile', { method: 'PUT', headers: bearer(), body: JSON.stringify(body) });
const updates = (pool) => pool.calls.filter((c) => c.sql.includes('UPDATE "AspNetUsers"'));

describe('account profile', () => {
  it('returns the signed-in person\'s name, email and phone', async () => {
    const pool = fakePool({ phone: '+234 801 234 5678' });
    const res = await call(createApp(env, pool), '/api/account/profile', { headers: bearer() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { fullName: 'Owner', email: 'owner@example.test', phone: '+234 801 234 5678' });
  });

  it('requires sign-in', async () => {
    const pool = fakePool();
    const res = await call(createApp(env, pool), '/api/account/profile');
    assert.equal(res.status, 401);
  });

  it('saves a trimmed name and phone and writes one audit row without the values', async () => {
    const pool = fakePool();
    const res = await put(pool, { fullName: '  Ada Obi  ', phone: ' +234 801 234 5678 ' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { fullName: 'Ada Obi', email: 'owner@example.test', phone: '+234 801 234 5678' });
    const [update] = updates(pool);
    assert.deepEqual(update.values, [ME.userId, 'Ada Obi', '+234 801 234 5678']);
    const audit = pool.calls.filter((c) => c.sql.includes('INSERT INTO "AuditLogs"'));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].values[1], 'account.profile_updated');
    assert.ok(!JSON.stringify(audit[0].values).includes('Ada'));
  });

  it('clears the phone when it is blank or null', async () => {
    for (const phone of ['', '   ', null, undefined]) {
      const pool = fakePool();
      const res = await put(pool, { fullName: 'Ada Obi', phone });
      assert.equal(res.status, 200);
      assert.equal(updates(pool)[0].values[2], null);
      assert.equal(res.body.phone, null);
    }
  });

  it('only ever edits the caller\'s own row, whatever the body says', async () => {
    const pool = fakePool();
    const res = await put(pool, { fullName: 'Ada Obi', userId: SOMEONE_ELSE, email: 'other@example.test' });
    assert.equal(res.status, 200);
    assert.equal(updates(pool).length, 1);
    assert.equal(updates(pool)[0].values[0], ME.userId);
    assert.ok(!JSON.stringify(updates(pool)[0].values).includes('other@example.test'));
  });

  it('rejects a bad name or phone without touching the database', async () => {
    for (const body of [
      { fullName: 'A' },
      { fullName: '   ' },
      { fullName: 'x'.repeat(121) },
      { fullName: 'Ada Obi', phone: 'call me' },
      { fullName: 'Ada Obi', phone: '1'.repeat(41) },
      {},
    ]) {
      const pool = fakePool();
      const res = await put(pool, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(res.body.code, 'validation_failed');
      assert.equal(updates(pool).length, 0);
    }
  });
});
