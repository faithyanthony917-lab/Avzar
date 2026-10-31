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
const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const membershipId = '00000000-0000-4000-8000-000000000040';
const leaveId = '00000000-0000-4000-8000-000000000070';

function token() {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, {
    userId,
    businessId,
    sessionId: '00000000-0000-4000-8000-000000000003',
  }).token;
}

async function post(app, pathname, body) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function makePool(permissions) {
  const membership = {
    UserId: userId, Email: 'worker@example.test', FullName: 'Worker', BusinessId: businessId,
    BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: permissions,
  };
  const query = async (sql) => {
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('JOIN "AspNetUsers"')) return { rows: [membership] };
    return { rows: [] };
  };
  return {
    query,
    connect: async () => ({
      query: async (sql) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        // Step 16a: the leave managers are looked up (nobody is queued here) and planned work is checked.
        if (sql.includes('array_agg')) return { rows: [{ DisplayName: 'Worker', TimeZoneId: 'UTC', LocationIds: [] }] };
        if (sql.includes('FROM "ProductionTasks" t')) return { rows: [{ Count: 0 }] };
        if (sql.includes('JOIN "AspNetUsers" appUser')) return { rows: [] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ Id: membershipId }] };
        if (sql.includes('INSERT INTO "WorkerLeaves"')) return { rows: [{
          Id: leaveId, MembershipId: membershipId,
          StartsAtUtc: new Date('2026-07-01T09:00:00Z'),
          EndsAtUtc: new Date('2026-07-01T12:00:00Z'),
          Reason: 'Annual leave', Status: 'Pending', ReviewNote: null,
        }] };
        if (sql.includes('INSERT INTO "AuditLogs"')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
      release() {},
    }),
  };
}

describe('worker schedule routes', () => {
  it('routes personal leave requests through task-work permission and persistent transaction', async () => {
    const app = createApp(env, makePool(['tasks.work']));
    const response = await post(app, '/api/my/leave-requests', {
      startsAtUtc: '2026-07-01T09:00:00Z',
      endsAtUtc: '2026-07-01T12:00:00Z',
      reason: 'Annual leave',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.id, leaveId);
    assert.equal(response.body.status, 'Pending');
  });

  it('denies personal leave requests without task-work permission', async () => {
    const app = createApp(env, makePool(['customers.view']));
    const response = await post(app, '/api/my/leave-requests', {
      startsAtUtc: '2026-07-01T09:00:00Z',
      endsAtUtc: '2026-07-01T12:00:00Z',
      reason: 'Annual leave',
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden');
  });
});
