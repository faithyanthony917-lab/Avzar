import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const otherBusinessId = '00000000-0000-4000-8000-000000000022';
const userId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000003';
const locationId = '00000000-0000-4000-8000-000000000060';
const env = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 8081, LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};

function bearer(business = businessId) {
  return issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES },
  { userId, businessId: business, sessionId }).token;
}

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* Keep empty and plain-text responses unchanged. */ }
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function reportPool({ owner = true, permissions = ['reports.view'], tier = 'basic', allowed = [locationId], activeBusiness = businessId } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) {
        return values[1] === activeBusiness ? { rows: [{ UserId: userId, Email: 'owner@example.test', FullName: 'Owner', BusinessId: activeBusiness,
          BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: owner, Permissions: permissions }] } : { rows: [] };
      }
      if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: tier }] };
      if (sql.includes('SELECT DISTINCT ml."LocationId"')) return { rows: allowed.map((LocationId) => ({ LocationId })) };
      if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'USD' }] };
      if (sql.includes('AS "OrdersCreated"')) return { rows: [{ OrdersCreated: 4, OrdersDelivered: 2, OrderValue: '125.50',
        VerifiedRevenue: '95.75', Expenses: '25.25', OpenTasks: 3, CompletedTasks: 6, OverdueTasks: 1 }] };
      if (sql.includes('WITH days AS')) return { rows: [
        { Date: '2026-10-16', VerifiedRevenue: '60.25', Expenses: '10.25', Orders: 2 },
        { Date: '2026-10-17', VerifiedRevenue: '35.50', Expenses: '15.00', Orders: 2 },
      ] };
      return { rows: [] };
    },
  };
}

describe('reports summary route', () => {
  it('returns C# summary shape with exact database money totals and a daily series', async () => {
    const pool = reportPool();
    const result = await requestApp(createApp(env, pool), '/api/reports/summary?from=2026-10-16&to=2026-10-17', {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      from: '2026-10-16', to: '2026-10-17', currencyCode: 'USD', ordersCreated: 4, ordersDelivered: 2,
      orderValue: 125.5, verifiedRevenue: 95.75, expenses: 25.25, grossAfterExpenses: 70.5,
      lateDeliveries: 0, overdueDeliveries: 0, averageProductionHours: 0, completedProductionTasks: 0,
      activeCustomers: 0, returningCustomers: 0, customerRetentionRate: 0,
      popularGarments: [], popularCollections: [], materialUsage: [],
      openTasks: 3, completedTasks: 6, overdueTasks: 1,
      daily: [
        { date: '2026-10-16', verifiedRevenue: 60.25, expenses: 10.25, orders: 2 },
        { date: '2026-10-17', verifiedRevenue: 35.5, expenses: 15, orders: 2 },
      ],
    });
  });

  it('validates ranges and denies missing authentication, reports permission, or report entitlement', async () => {
    const pool = reportPool();
    const invalid = await requestApp(createApp(env, pool), '/api/reports/summary?from=2026-10-18&to=2026-10-17', {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_report_range');

    const unauthenticated = await requestApp(createApp(env, pool), '/api/reports/summary');
    assert.equal(unauthenticated.status, 401);
    const forbidden = await requestApp(createApp(env, reportPool({ owner: false, permissions: ['orders.view'] })), '/api/reports/summary', {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(forbidden.status, 403);
    const noTier = await requestApp(createApp(env, reportPool({ tier: 'none' })), '/api/reports/summary', {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(noTier.status, 403);
    assert.equal(noTier.body.code, 'feature_not_in_plan');
  });

  it('hides another business and scopes restricted reports to assigned locations', async () => {
    const isolated = await requestApp(createApp(env, reportPool({ activeBusiness: businessId })), '/api/reports/summary', {
      headers: { authorization: `Bearer ${bearer(otherBusinessId)}` },
    });
    assert.equal(isolated.status, 401);

    const pool = reportPool({ owner: false, permissions: ['reports.view'], allowed: [locationId] });
    const response = await requestApp(createApp(env, pool), '/api/reports/summary?from=2026-10-16&to=2026-10-17', {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(response.status, 200);
    const aggregate = pool.calls.find((call) => call.sql.includes('AS "OrdersCreated"'));
    assert.deepEqual(aggregate.values[3], [locationId]);
    const analyticsQueries = pool.calls.filter((call) => /"Orders"|"ProductionTasks"|"OrderGarments"|"DesignCollections"|"Materials"/.test(call.sql));
    assert.ok(analyticsQueries.length >= 5);
    for (const call of analyticsQueries) {
      assert.ok(call.values.includes(businessId), 'analytics query must be scoped to the active business');
      if (call.sql.includes('ANY($4::uuid[])')) assert.deepEqual(call.values[3], [locationId]);
    }
  });
});