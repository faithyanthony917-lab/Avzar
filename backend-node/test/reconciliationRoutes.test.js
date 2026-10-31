import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

// Step 15c: GET /api/reports/reconciliation over HTTP with a pool that answers each statement the service sends. Covers permissions,
// plan tier, date validation, the shape of the answer and that a location-limited user's locations reach every query. It cannot prove
// isolation or the SQL itself: that is test/db/reconciliation.integration.test.js (restricted role, real PostgreSQL).

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000003';
const locationId = '00000000-0000-4000-8000-000000000060';
const env = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 8081, LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};
const bearer = () => issueAccessToken({
  jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
}, { userId, businessId, sessionId }).token;

async function get(app, pathname) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers: { authorization: `Bearer ${bearer()}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function makePool({ owner = false, permissions = ['reports.view', 'payments.view'], tier = 'basic', allowed = [locationId], overrides = {} } = {}) {
  const calls = [];
  const handle = async (sql, values = []) => {
    const text = String(sql);
    calls.push({ sql: text, values });
    if (text.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (text.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) {
      return { rows: [{ UserId: userId, Email: 'staff@example.test', FullName: 'Staff', BusinessId: businessId, BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: owner, Permissions: permissions }] };
    }
    if (text.includes('FROM "Plans" p')) return { rows: [{ Value: tier }] };
    if (text.includes('SELECT DISTINCT ml."LocationId"')) return { rows: allowed.map((LocationId) => ({ LocationId })) };
    if (text.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', TimeZoneId: 'UTC' }] };
    for (const [needle, rows] of Object.entries(overrides)) if (text.includes(needle)) return { rows };
    return { rows: [] };
  };
  return { calls, query: handle, connect: async () => ({ query: handle, release() {} }) };
}

const URL_OK = '/api/reports/reconciliation?from=2026-10-01&to=2026-10-27';
const reconciliationCalls = (pool) => pool.calls.filter((call) => call.sql.includes('"InvoicePaymentAttempts"') || call.sql.includes('FROM "Payments" p') || call.sql.includes('FROM "Invoices" i'));

describe('reconciliation report route', () => {
  it('needs both reports.view and payments.view', async () => {
    assert.equal((await get(createApp(env, makePool({ permissions: ['reports.view'] })), URL_OK)).status, 403);
    assert.equal((await get(createApp(env, makePool({ permissions: ['payments.view'] })), URL_OK)).status, 403);
    assert.equal((await get(createApp(env, makePool({ permissions: [] })), URL_OK)).status, 403);
    assert.equal((await get(createApp(env, makePool()), URL_OK)).status, 200);
  });

  it('is refused below the basic reports tier', async () => {
    const result = await get(createApp(env, makePool({ tier: 'none' })), URL_OK);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'feature_not_in_plan');
  });

  it('refuses a bad or too long range with 400 before reading any payment', async () => {
    for (const query of ['from=nope', 'from=2026-10-27&to=2026-10-01', 'from=2026-01-01&to=2026-10-27']) {
      const pool = makePool();
      const result = await get(createApp(env, pool), `/api/reports/reconciliation?${query}`);
      assert.equal(result.status, 400, query);
      assert.equal(result.body.code, 'invalid_report_range');
      assert.equal(reconciliationCalls(pool).length, 0, 'no payment data is read for a bad range');
    }
  });

  it('answers an empty business with a complete, all-zero report', async () => {
    const result = await get(createApp(env, makePool()), URL_OK);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const body = result.body;
    assert.deepEqual([body.from, body.to, body.currencyCode, body.attentionCount], ['2026-10-01', '2026-10-27', 'NGN', 0]);
    assert.deepEqual([body.collected.count, body.collected.amount, body.collected.byMethod.length], [0, 0, 0]);
    for (const key of ['needsReviewPayments', 'staleLinks', 'pendingVerification', 'paymentsOnVoidedInvoices', 'onlineMismatches']) {
      assert.deepEqual([body.needsAttention[key].count, body.needsAttention[key].truncated, body.needsAttention[key].items], [0, false, []], key);
    }
    assert.equal(body.needsAttention.pendingVerification.thresholdDays, 3);
    assert.deepEqual([body.invoices.openCount, body.invoices.overdueCount, body.invoices.installmentsOverdue.plans], [0, 0, 0]);
  });

  it('shapes collected money and findings from the rows the database returns', async () => {
    const pool = makePool({ overrides: {
      'GROUP BY 1, 2': [{ Method: 'Card', Online: true, Count: 2, Amount: '300.00' }, { Method: 'Cash', Online: false, Count: 1, Amount: '50.50' }],
      '\'NeedsReview\'': [{ Id: 'a1', InvoiceId: 'i1', InvoiceNumber: 'INV-1', Amount: '120.00', CurrencyCode: 'NGN', Reference: 'ref-1', FailureReason: 'overpayment', Source: 'Portal', UpdatedAtUtc: new Date('2026-10-20T10:00:00Z'), Total: 4, TotalAmount: '480.00' }],
      '"OpenCount"': [{ OpenCount: 3, OpenBalance: '900.00', OverdueCount: 1, OverdueBalance: '200.00' }],
      'payment_missing': [{ Id: 'a2', InvoiceId: 'i2', InvoiceNumber: 'INV-2', Amount: '75.00', CurrencyCode: 'NGN', Reference: 'ref-2', PaymentId: 'p2', PaymentStatus: 'Reversed', PaymentAmount: '75.00', Kind: 'reversed', Total: 1, TotalAmount: '75.00' }],
    } });
    const { body } = await get(createApp(env, pool), URL_OK);
    assert.deepEqual([body.collected.count, body.collected.amount, body.collected.online.amount, body.collected.staffRecorded.amount], [3, 350.5, 300, 50.5]);
    const review = body.needsAttention.needsReviewPayments;
    assert.deepEqual([review.count, review.amount, review.truncated, review.items.length], [4, 480, false, 1]);
    assert.deepEqual([review.items[0].reason, review.items[0].reference, review.items[0].updatedAtUtc], ['overpayment', 'ref-1', '2026-10-20T10:00:00.000Z']);
    const mismatch = body.needsAttention.onlineMismatches.items[0];
    assert.equal(mismatch.kind, 'reversed');
    assert.match(mismatch.note, /refunding in Paystack/);
    assert.equal(body.attentionCount, 5);
    assert.deepEqual([body.invoices.openCount, body.invoices.openBalance, body.invoices.overdueBalance], [3, 900, 200]);
  });

  it('passes a location-limited user\'s locations to every payment query and no list for an unlimited user', async () => {
    const limited = makePool({ permissions: ['reports.view', 'payments.view'] });
    assert.equal((await get(createApp(env, limited), URL_OK)).status, 200);
    const scoped = reconciliationCalls(limited).filter((call) => call.sql.includes('$2::uuid[]'));
    assert.ok(scoped.length >= 7, `expected every report query to be scoped, saw ${scoped.length}`);
    for (const call of scoped) assert.deepEqual(call.values[1], [locationId]);

    const everywhere = makePool({ owner: true });
    assert.equal((await get(createApp(env, everywhere), URL_OK)).status, 200);
    for (const call of reconciliationCalls(everywhere).filter((c) => c.sql.includes('$2::uuid[]'))) assert.equal(call.values[1], null);
  });
});
