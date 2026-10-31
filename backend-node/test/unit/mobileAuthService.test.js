import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { currentUser, createMobileSession, rotateMobileSession } from '../../src/auth/mobileAuthService.js';
import { loadEnv } from '../../src/config/env.js';

const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000003';
const row = (extra = {}) => ({
  UserId: userId,
  Email: 'member@example.test',
  FullName: 'Shop Member',
  BusinessId: businessId,
  BusinessName: 'Avzar Shop',
  TimeZoneId: 'Africa/Lagos',
  CurrencyCode: 'NGN',
  IsOwner: false,
  Permissions: ['customers.view'],
  ...extra,
});
const sessionEnv = loadEnv({
  NODE_ENV: 'test',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  REFRESH_IDLE_DAYS: '30',
  REFRESH_ABSOLUTE_DAYS: '90',
  MAX_SESSIONS_PER_USER: '10',
});
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('current-user lookup scopes access to the authenticated business', async () => {
  let values;
  const db = { query: async (_sql, params) => { values = params; return { rows: [row()] }; } };
  const user = await currentUser(db, userId, businessId);
  assert.deepEqual(values, [userId, businessId]);
  assert.deepEqual(user.permissions, ['customers.view']);

  const owner = await currentUser({ query: async () => ({ rows: [row({ IsOwner: true, Permissions: [] })] }) }, userId, businessId);
  assert.ok(owner.permissions.includes('payments.verify'));
  assert.ok(owner.permissions.includes('locations.all'));

  const forbidden = await currentUser({ query: async () => ({ rows: [] }) }, userId, '00000000-0000-4000-8000-000000000099');
  assert.equal(forbidden, null);
});

test('mobile session creation stores only a token hash and requires active membership', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM "Memberships" m')) return { rows: [row()] };
      if (sql.includes('FROM "UserSessions"')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const result = await createMobileSession({ connect: async () => client }, userId, businessId, 'Test device', sessionEnv, new Date('2026-01-01T00:00:00Z'));
  const insert = calls.find((call) => call.sql.includes('INSERT INTO "UserSessions"'));
  assert.ok(insert);
  assert.equal(insert.values[1], userId);
  assert.equal(insert.values[2], businessId);
  assert.equal(insert.values[3], 'Test device');
  assert.match(insert.values[4], /^[a-f0-9]{64}$/);
  assert.notEqual(insert.values[4], result.refreshToken.split('.')[1]);
  assert.match(result.refreshToken, /^[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/);
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));

  const deniedClient = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM "Memberships" m')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(
    createMobileSession({ connect: async () => deniedClient }, userId, businessId, null, sessionEnv),
    (error) => error.code === 'not_a_member' && error.status === 403,
  );
});

test('refresh rotates tokens and replaying the prior token revokes the session', async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const oldSecret = 'a'.repeat(48);
  const presented = `${sessionId.replaceAll('-', '')}.${oldSecret}`;
  const baseSession = {
    Id: sessionId,
    UserId: userId,
    BusinessId: businessId,
    CurrentTokenHash: hash(oldSecret),
    PreviousTokenHash: null,
    RevokedAtUtc: null,
    IdleExpiresAtUtc: new Date('2026-02-01T00:00:00Z'),
    AbsoluteExpiresAtUtc: new Date('2026-04-01T00:00:00Z'),
  };
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('SELECT * FROM "UserSessions"')) return { rows: [baseSession] };
      if (sql.includes('SELECT "LockoutEnabled"')) return { rows: [{ LockoutEnabled: true, LockoutEnd: null }] };
      if (sql.includes('FROM "Memberships" m')) return { rows: [row()] };
      return { rows: [] };
    },
    release() {},
  };
  const rotated = await rotateMobileSession({ connect: async () => client }, presented, sessionEnv, now);
  assert.equal(rotated.userId, userId);
  assert.equal(rotated.businessId, businessId);
  assert.equal(rotated.sessionId, sessionId);
  assert.notEqual(rotated.refreshToken, presented);
  assert.ok(calls.some((call) => call.sql.includes('"PreviousTokenHash" = "CurrentTokenHash"')));
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));

  const replayCalls = [];
  const replayClient = {
    async query(sql, values = []) {
      replayCalls.push({ sql, values });
      if (sql.includes('SELECT * FROM "UserSessions"')) return { rows: [{
        ...baseSession,
        CurrentTokenHash: hash('b'.repeat(48)),
        PreviousTokenHash: hash(oldSecret),
      }] };
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(
    rotateMobileSession({ connect: async () => replayClient }, presented, sessionEnv, now),
    (error) => error.code === 'token_reuse_detected' && error.status === 401,
  );
  assert.ok(replayCalls.some((call) => call.sql.includes("'token_reuse'")));
  assert.ok(replayCalls.some((call) => call.sql === 'COMMIT'));
});