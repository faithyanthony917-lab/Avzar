import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const bizA = '00000000-0000-4000-8000-00000000a001';
const bizB = '00000000-0000-4000-8000-00000000b001';
const userA = '00000000-0000-4000-8000-00000000a0a1';
const userA2 = '00000000-0000-4000-8000-00000000a0a2';
const userB = '00000000-0000-4000-8000-00000000b0b1';
const memberA = '00000000-0000-4000-8000-0000000000e1';
const memberA2 = '00000000-0000-4000-8000-0000000000e2';
const memberB = '00000000-0000-4000-8000-0000000000e3';
const sessionId = '00000000-0000-4000-8000-000000000003';
const task = '00000000-0000-4000-8000-0000000000c1';
const env = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 8081, LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
  EXPO_ACCESS_TOKEN: 'test-expo-access-token',
};

const bearer = (userId, businessId) => issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER,
  jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES }, { userId, businessId, sessionId }).token;

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* keep plain text */ }
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const call = (path, token, { method = 'GET', body } = {}) => ({ path, init: {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
} });

// A small in-memory stand-in for the notification tables. It implements the same filters the SQL has, so a query that forgot
// the business or membership condition would leak rows here and fail the cross-tenant tests.
function fakePool() {
  const members = new Map([[`${userA}:${bizA}`, memberA], [`${userA2}:${bizA}`, memberA2], [`${userB}:${bizB}`, memberB]]);
  const pushTokens = [];
  const rows = [
    { Id: '00000000-0000-4000-8000-000000000f01', BusinessId: bizA, RecipientMembershipId: memberA, Category: 'tasks', EventType: 'task.assigned', Title: 'Task assigned', Body: 'Body', TargetKind: 'task', TargetId: task, CreatedAtUtc: new Date('2026-10-20T10:00:00Z'), ReadAtUtc: null },
    { Id: '00000000-0000-4000-8000-000000000f02', BusinessId: bizA, RecipientMembershipId: memberA, Category: 'orders', EventType: 'order.confirmed', Title: 'Order confirmed', Body: 'Body', TargetKind: null, TargetId: null, CreatedAtUtc: new Date('2026-10-20T11:00:00Z'), ReadAtUtc: null },
    { Id: '00000000-0000-4000-8000-000000000f03', BusinessId: bizA, RecipientMembershipId: memberA2, Category: 'tasks', EventType: 'task.assigned', Title: 'Other person', Body: 'Body', TargetKind: null, TargetId: null, CreatedAtUtc: new Date('2026-10-20T12:00:00Z'), ReadAtUtc: null },
  ];
  const prefs = [];
  const pool = {
    rows, prefs, calls: [],
    async query(sql, v = []) {
      pool.calls.push({ sql, v });
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) {
        return members.has(`${v[0]}:${v[1]}`) ? { rows: [{ UserId: v[0], Email: 'x@example.test', FullName: 'X', BusinessId: v[1], BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: [] }] } : { rows: [] };
      }
      if (sql.includes('SELECT "Id" FROM "Memberships"')) return members.has(`${v[0]}:${v[1]}`) ? { rows: [{ Id: members.get(`${v[0]}:${v[1]}`) }] } : { rows: [] };
      if (sql.includes('FROM "Notifications"') && sql.includes('count(*)')) {
        return { rows: [{ Count: rows.filter((r) => r.BusinessId === v[0] && r.RecipientMembershipId === v[1] && !r.ReadAtUtc).length }] };
      }
      if (sql.includes('FROM "Notifications"') && sql.includes('ORDER BY')) {
        const mine = rows.filter((r) => r.BusinessId === v[0] && r.RecipientMembershipId === v[1] && (!v[2] || !r.ReadAtUtc) && (v[3] === null || r.Category === v[3]))
          .sort((a, b) => b.CreatedAtUtc - a.CreatedAtUtc);
        return { rows: mine.slice(0, v[6]) };
      }
      if (sql.includes('UPDATE "Notifications" SET "ReadAtUtc" = COALESCE')) {
        const hit = rows.find((r) => r.Id === v[0] && r.BusinessId === v[1] && r.RecipientMembershipId === v[2]);
        if (!hit) return { rows: [] };
        hit.ReadAtUtc ??= v[3];
        return { rows: [hit] };
      }
      if (sql.includes('UPDATE "Notifications" SET "ReadAtUtc" = $3')) {
        const hits = rows.filter((r) => r.BusinessId === v[0] && r.RecipientMembershipId === v[1] && !r.ReadAtUtc && (v[3] === null || r.Category === v[3]));
        hits.forEach((r) => { r.ReadAtUtc = v[2]; });
        return { rowCount: hits.length, rows: [] };
      }
      if (sql.includes('FROM "NotificationPreferences"')) return { rows: prefs.filter((p) => p.BusinessId === v[0] && p.MembershipId === v[1]) };
      if (sql.includes('FROM "NotificationSettings"')) return { rows: [] };
      if (sql.includes('FROM "PushTokens"')) {
        return { rows: pushTokens.filter((token) => token.BusinessId === v[0] && token.MembershipId === v[1] && token.Active).map((token) => ({ Token: token.Token, Platform: token.Platform, DeviceName: token.DeviceName })) };
      }
      if (sql.includes('INSERT INTO "PushTokens"')) {
        const row = { Id: v[0], MembershipId: v[1], BusinessId: v[2], Token: v[3], Platform: v[4], DeviceName: v[5], Active: true, CreatedAtUtc: new Date(), UpdatedAtUtc: new Date() };
        const index = pushTokens.findIndex((token) => token.BusinessId === row.BusinessId && token.MembershipId === row.MembershipId && token.Token === row.Token);
        if (index >= 0) pushTokens[index] = row; else pushTokens.push(row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      const statements = [];
      return {
        statements,
        async query(sql, v = []) {
          statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
          pool.calls.push({ sql, values: v });
          if (sql.includes('SELECT 1 FROM "UserSessions"')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
          if (sql.includes('INSERT INTO "PushTokens"')) {
            const row = { Id: v[0], MembershipId: v[1], BusinessId: v[2], Token: v[3], Platform: v[4], DeviceName: v[5], Active: true, CreatedAtUtc: v[6], UpdatedAtUtc: v[6], SessionId: v[7] };
            const index = pushTokens.findIndex((token) => token.Token === row.Token && token.Active);
            if (index >= 0) pushTokens[index] = row; else pushTokens.push(row);
            return { rows: [row], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO "NotificationPreferences"')) {
            const next = { MembershipId: v[0], BusinessId: v[1], Category: v[2], InAppEnabled: v[3], EmailEnabled: v[4], PushEnabled: v[5] };
            const i = prefs.findIndex((p) => p.MembershipId === v[0] && p.Category === v[2]);
            if (i >= 0) prefs[i] = next; else prefs.push(next);
          }
          return { rows: [], rowCount: sql.includes('UPDATE "PushTokens"') ? 1 : 0 };
        },
        release() {},
      };
    },
  };
  return pool;
}

describe('notification routes', () => {
  it('requires authentication on every route (no token, or a token that does not verify)', async () => {
    const app = createApp(env, fakePool());
    for (const [path, method] of [['/api/notifications', 'GET'], ['/api/notifications/unread-count', 'GET'], ['/api/notifications/preferences', 'GET'],
      ['/api/notifications/read-all', 'POST'], [`/api/notifications/${rowId(1)}/read`, 'POST'], ['/api/notifications/preferences', 'PUT']]) {
      // A bad bearer token is exempt from CSRF but must still fail authentication; GET needs no CSRF token at all.
      const { status } = await requestApp(app, path, call(path, 'not-a-token', { method, body: method === 'GET' ? undefined : {} }).init);
      assert.equal(status, 401, `${method} ${path} with a bad token`);
    }
    assert.equal((await requestApp(app, '/api/notifications')).status, 401);
  });

  it('lists only the caller\'s own notifications, newest first, with the safe public shape', async () => {
    const { path, init } = call('/api/notifications', bearer(userA, bizA));
    const result = await requestApp(createApp(env, fakePool()), path, init);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items.map((item) => item.title), ['Order confirmed', 'Task assigned']);
    assert.equal(result.body.nextCursor, null);
    assert.deepEqual(Object.keys(result.body.items[0]).sort(), ['body', 'category', 'createdAtUtc', 'eventType', 'id', 'isRead', 'readAtUtc', 'target', 'title']);
    assert.deepEqual(result.body.items[1].target, { kind: 'task', id: task });
  });

  it('filters by category and unread, and pages with a cursor', async () => {
    const pool = fakePool();
    const token = bearer(userA, bizA);
    let r = await requestApp(createApp(env, pool), ...Object.values(call('/api/notifications?category=tasks', token)));
    assert.deepEqual(r.body.items.map((i) => i.category), ['tasks']);
    r = await requestApp(createApp(env, pool), ...Object.values(call('/api/notifications?limit=1', token)));
    assert.equal(r.body.items.length, 1);
    assert.ok(r.body.nextCursor);
    pool.rows[1].ReadAtUtc = new Date();
    r = await requestApp(createApp(env, pool), ...Object.values(call('/api/notifications?unread=true', token)));
    assert.deepEqual(r.body.items.map((i) => i.title), ['Task assigned']);
  });

  it('rejects malformed query parameters with a stable code', async () => {
    const token = bearer(userA, bizA);
    for (const [query, code] of [['limit=0', 'invalid_limit'], ['limit=abc', 'invalid_limit'], ['limit=1&limit=2', 'invalid_limit'], ['unread=maybe', 'invalid_unread'],
      ['category=weather', 'invalid_category'], ['cursor=garbage', 'invalid_cursor']]) {
      const r = await requestApp(createApp(env, fakePool()), ...Object.values(call(`/api/notifications?${query}`, token)));
      assert.equal(r.status, 400, query);
      assert.equal(r.body.code, code, query);
    }
  });

  it('reports the unread count and marks one or all as read', async () => {
    const pool = fakePool();
    const app = createApp(env, pool);
    const token = bearer(userA, bizA);
    assert.deepEqual((await requestApp(app, ...Object.values(call('/api/notifications/unread-count', token)))).body, { count: 2, capped: false });
    const one = await requestApp(app, ...Object.values(call(`/api/notifications/${rowId(1)}/read`, token, { method: 'POST' })));
    assert.equal(one.status, 200);
    assert.equal(one.body.isRead, true);
    assert.equal((await requestApp(app, ...Object.values(call('/api/notifications/unread-count', token)))).body.count, 1);
    const all = await requestApp(app, ...Object.values(call('/api/notifications/read-all', token, { method: 'POST', body: {} })));
    assert.deepEqual(all.body, { updated: 1 });
    assert.equal((await requestApp(app, ...Object.values(call('/api/notifications/unread-count', token)))).body.count, 0);
  });

  it('CROSS-TENANT: another business can never list, count or mark this business\'s notifications', async () => {
    const pool = fakePool();
    const app = createApp(env, pool);
    const tokenB = bearer(userB, bizB);
    assert.deepEqual((await requestApp(app, ...Object.values(call('/api/notifications', tokenB)))).body.items, []);
    assert.equal((await requestApp(app, ...Object.values(call('/api/notifications/unread-count', tokenB)))).body.count, 0);
    const mark = await requestApp(app, ...Object.values(call(`/api/notifications/${rowId(1)}/read`, tokenB, { method: 'POST' })));
    assert.equal(mark.status, 404);
    assert.equal(mark.body.code, 'notification_not_found');
    assert.deepEqual((await requestApp(app, ...Object.values(call('/api/notifications/read-all', tokenB, { method: 'POST', body: {} })))).body, { updated: 0 });
    assert.ok(pool.rows.every((r) => r.ReadAtUtc === null), 'nothing in business A was touched');
  });

  it('CROSS-TENANT: a token naming a business the person does not belong to is refused', async () => {
    const r = await requestApp(createApp(env, fakePool()), ...Object.values(call('/api/notifications', bearer(userA, bizB))));
    assert.equal(r.status, 401);
  });

  it('SAME BUSINESS: a colleague cannot read or mark someone else\'s notifications', async () => {
    const pool = fakePool();
    const app = createApp(env, pool);
    const colleague = bearer(userA2, bizA);
    const list = await requestApp(app, ...Object.values(call('/api/notifications', colleague)));
    assert.deepEqual(list.body.items.map((i) => i.title), ['Other person']);
    const mark = await requestApp(app, ...Object.values(call(`/api/notifications/${rowId(1)}/read`, colleague, { method: 'POST' })));
    assert.equal(mark.status, 404);
    assert.equal(pool.rows[0].ReadAtUtc, null);
  });

  it('treats a malformed notification id as not found', async () => {
    const r = await requestApp(createApp(env, fakePool()), ...Object.values(call('/api/notifications/not-a-uuid/read', bearer(userA, bizA), { method: 'POST' })));
    assert.equal(r.status, 404);
  });

  it('returns defaults when nothing is saved: email on only for tasks and push is available when configured', async () => {
    const r = await requestApp(createApp(env, fakePool()), ...Object.values(call('/api/notifications/preferences', bearer(userA, bizA))));
    assert.equal(r.status, 200);
    assert.equal(r.body.pushAvailable, true);
    assert.deepEqual(r.body.quietHours, { enabled: false, startMinute: 1320, endMinute: 420 });
    assert.deepEqual(r.body.categories.filter((c) => c.email).map((c) => c.category), ['tasks']);
    assert.equal(r.body.categories.length, 7);
  });

  it('registers a mobile push token for the authenticated membership', async () => {
    const pool = fakePool();
    const app = createApp(env, pool);
    const r = await requestApp(app, ...Object.values(call('/api/auth/push-token', bearer(userA, bizA), {
      method: 'POST',
      body: { token: 'ExponentPushToken[abc123]', platform: 'ios', deviceName: 'iPhone 15' },
    })));
    assert.equal(r.status, 204);
    assert.equal(pool.calls.some((callEntry) => callEntry.sql.includes('INSERT INTO "PushTokens"')), true);
  });

  it('saves preferences for the caller\'s own membership in a transaction and returns them', async () => {
    const pool = fakePool();
    const r = await requestApp(createApp(env, pool), ...Object.values(call('/api/notifications/preferences', bearer(userA, bizA), {
      method: 'PUT', body: { categories: [{ category: 'orders', inApp: true, email: true }], quietHours: { enabled: true, startMinute: 1320, endMinute: 420 } },
    })));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.categories.find((c) => c.category === 'orders'), { category: 'orders', inApp: true, email: true, push: false });
    assert.deepEqual(pool.prefs.map((p) => [p.MembershipId, p.BusinessId]), [[memberA, bizA]]);
  });

  it('validates preferences: unknown category, bad minutes, equal quiet times, duplicates, extra fields, empty body', async () => {
    const token = bearer(userA, bizA);
    const bad = [
      { categories: [{ category: 'weather', inApp: true, email: false }] },
      { quietHours: { enabled: true, startMinute: 1440, endMinute: 0 } },
      { quietHours: { enabled: true, startMinute: 600, endMinute: 600 } },
      { categories: [{ category: 'orders', inApp: true, email: false }, { category: 'orders', inApp: false, email: false }] },
      { categories: [{ category: 'orders', inApp: true, email: false, membershipId: memberA2 }] },
      { membershipId: memberA2, categories: [] },
      {},
    ];
    for (const body of bad) {
      const pool = fakePool();
      const r = await requestApp(createApp(env, pool), ...Object.values(call('/api/notifications/preferences', token, { method: 'PUT', body })));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'invalid_preferences', JSON.stringify(body));
      assert.equal(pool.prefs.length, 0);
    }
  });

  it('keeps the CSRF rule for cookie sessions: a cookie-only POST without a token is refused', async () => {
    const r = await requestApp(createApp(env, fakePool()), '/api/notifications/read-all', {
      method: 'POST', headers: { cookie: `tailoring.session=${bearer(userA, bizA)}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_csrf');
  });
});

function rowId(n) { return `00000000-0000-4000-8000-000000000f0${n}`; }
