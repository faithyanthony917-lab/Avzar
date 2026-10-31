import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { createBillingProvider } from '../src/auth/billingProvider.js';
import { computeUpgradeCredit, lastPaidBillingPeriod } from '../src/auth/subscriptionBillingService.js';
import { getTenantEntitlements } from '../src/auth/adminService.js';

const USER = '00000000-0000-4000-8000-000000000001';
const BIZ_A = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-000000000003';
const STARTER = '00000000-0000-4000-8000-000000000008';
const PRO = '00000000-0000-4000-8000-000000000009';
const DAY = 86_400_000;
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
  BILLING_PAYSTACK_SECRET_KEY: 'sk_test_secret',
};
const authHeaders = () => ({
  authorization: `Bearer ${issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: 10 }, { userId: USER, businessId: BIZ_A, sessionId: SESSION }).token}`,
  'content-type': 'application/json',
});

async function send(app, pathname, body, headers = authHeaders()) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await response.text();
    let json = text; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

/** Fake Postgres for checkout: the current subscription, the plan being bought and the last paid payment of the current plan. */
function checkoutPool({ target, subscription, lastPayment = null }) {
  const state = { payments: [] };
  async function query(rawSql, values = []) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: USER, BusinessId: values[1], Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: ['business.settings'] }] };
    if (sql.includes('FROM "Subscriptions" s JOIN "Plans" cp')) return { rows: subscription ? [subscription] : [] };
    if (sql.includes('FROM "Plans" WHERE "Code"')) return { rows: values[0] === target.Code ? [target] : [] };
    if (sql.includes('FROM "Businesses"')) return { rows: [{ ContactEmail: 'owner@example.test' }] };
    if (sql.includes('FROM "SubscriptionPayments" WHERE "BusinessId"')) return { rows: lastPayment ? [lastPayment] : [] };
    if (sql.includes('INSERT INTO "SubscriptionPayments"')) { state.payments.push({ planId: values[2], period: values[3], amount: values[4] }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  return { query, async connect() { return { query, release() {} }; }, state };
}
const fakeBilling = () => {
  const calls = [];
  return { ...createBillingProvider(env), calls, initialize: async (args) => { calls.push(args); return { authorizationUrl: `https://pay.example.test/${args.reference}` }; } };
};
const starter = { Id: STARTER, Code: 'starter', CurrencyCode: 'NGN', MonthlyPrice: '5000.00', AnnualPrice: '50000.00' };
const professional = { Id: PRO, Code: 'professional', CurrencyCode: 'NGN', MonthlyPrice: '10000.00', AnnualPrice: '100000.00' };
const activeStarter = (daysLeft) => ({ Status: 'Active', PlanId: STARTER, CurrentPeriodEndUtc: new Date(Date.now() + daysLeft * DAY).toISOString(), CurrentMonthlyPrice: '5000.00' });
const url = '/api/billing/subscription/checkout';

describe('same-plan billing period switches at checkout', () => {
  it('monthly -> annual charges the full annual price with no credit; the remaining time is kept by stacking', async () => {
    const pool = checkoutPool({ target: starter, subscription: activeStarter(10), lastPayment: { Amount: '5000.00', BillingPeriod: 'monthly' } });
    const billing = fakeBilling();
    const res = await send(createApp(env, pool, { billingProvider: billing }), url, { planCode: 'starter', billingPeriod: 'annual' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(billing.calls[0].amountMinor, 5_000_000);
    assert.equal(billing.calls[0].metadata.creditMinor, 0);
    assert.equal(billing.calls[0].metadata.billingPeriod, 'annual');
    assert.equal(pool.state.payments[0].period, 'annual');
    assert.equal(res.body.creditAmount, 0);
  });
  it('monthly -> monthly and annual -> annual renew at the full price', async () => {
    for (const [last, period, minor] of [['monthly', 'monthly', 500_000], ['annual', 'annual', 5_000_000]]) {
      const pool = checkoutPool({ target: starter, subscription: activeStarter(10), lastPayment: { Amount: '1.00', BillingPeriod: last } });
      const billing = fakeBilling();
      const res = await send(createApp(env, pool, { billingProvider: billing }), url, { planCode: 'starter', billingPeriod: period });
      assert.equal(res.status, 200);
      assert.equal(billing.calls[0].amountMinor, minor);
    }
  });
  it('refuses annual -> monthly while the annual period is still running', async () => {
    const pool = checkoutPool({ target: starter, subscription: activeStarter(200), lastPayment: { Amount: '50000.00', BillingPeriod: 'annual' } });
    const res = await send(createApp(env, pool, { billingProvider: fakeBilling() }), url, { planCode: 'starter', billingPeriod: 'monthly' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'monthly_after_annual');
    assert.equal(pool.state.payments.length, 0);
  });
  it('allows monthly once the annual period has ended or the subscription is no longer Active', async () => {
    for (const subscription of [{ ...activeStarter(0), CurrentPeriodEndUtc: new Date(Date.now() - DAY).toISOString() }, { ...activeStarter(200), Status: 'PastDue' }, { ...activeStarter(200), Status: 'Trialing' }]) {
      const pool = checkoutPool({ target: starter, subscription, lastPayment: { Amount: '50000.00', BillingPeriod: 'annual' } });
      const res = await send(createApp(env, pool, { billingProvider: fakeBilling() }), url, { planCode: 'starter', billingPeriod: 'monthly' });
      assert.equal(res.status, 200, JSON.stringify(subscription));
    }
  });
  it('prorates an upgrade from the period of the LAST PAYMENT, not the period being bought', async () => {
    const pool = checkoutPool({ target: professional, subscription: activeStarter(15), lastPayment: { Amount: '5000.00', BillingPeriod: 'monthly' } });
    const billing = fakeBilling();
    const res = await send(createApp(env, pool, { billingProvider: billing }), url, { planCode: 'professional', billingPeriod: 'annual' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sent = billing.calls[0];
    assert.equal(sent.amountMinor + sent.metadata.creditMinor, 10_000_000, 'annual price minus the monthly credit');
    assert.ok(sent.metadata.creditMinor > 240_000 && sent.metadata.creditMinor <= 250_000, `credit ${sent.metadata.creditMinor}`);
  });
  it('credits an annual payment over a 365-day interval, capped at one interval', () => {
    const now = new Date('2026-10-19T00:00:00Z');
    const inDays = (n) => new Date(now.getTime() + n * DAY);
    assert.equal(computeUpgradeCredit({ paidMinor: 5_000_000, billingPeriod: 'annual', periodEnd: inDays(365), now }), 5_000_000);
    assert.equal(computeUpgradeCredit({ paidMinor: 5_000_000, billingPeriod: 'annual', periodEnd: inDays(730), now }), 5_000_000, 'stacked renewals never over-credit');
    assert.equal(computeUpgradeCredit({ paidMinor: 3_650_000, billingPeriod: 'annual', periodEnd: inDays(30), now }), 300_000);
    assert.equal(computeUpgradeCredit({ paidMinor: 3_650_000, billingPeriod: 'monthly', periodEnd: inDays(30), now }), 3_650_000, 'same days, monthly interval: a full month is left');
  });
});

describe('the period used when a payment is verified is the one that was checked out', () => {
  const reference = 'avz_period1';
  const rawEvent = JSON.stringify({ event: 'charge.success', data: { reference } });
  const signature = createHmac('sha512', env.BILLING_PAYSTACK_SECRET_KEY).update(rawEvent).digest('hex');

  function webhookPool(storedPeriod) {
    const state = { subscriptionUpdates: [] };
    const run = async (rawSql, values = []) => {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM "SubscriptionPayments" WHERE "ProviderReference"')) return { rows: [{ Id: 'pay-1', Status: 'Pending', Amount: '50000.00', CurrencyCode: 'NGN' }] };
      if (sql.includes('FROM "SubscriptionPayments" WHERE "Id" = $1 FOR UPDATE')) return { rows: [{ Id: 'pay-1', BusinessId: BIZ_A, PlanId: STARTER, BillingPeriod: storedPeriod, Status: 'Pending' }] };
      if (sql.startsWith('UPDATE "Subscriptions"')) { state.subscriptionUpdates.push({ businessId: values[0], planId: values[1], interval: values[2] }); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 1 };
    };
    return { query: run, async connect() { return { query: run, release() {} }; }, state };
  }
  const provider = () => ({ ...createBillingProvider(env), verify: async () => ({ status: 'success', reference, currency: 'NGN', amountMinor: 5_000_000 }) });

  it('extends by a year for an annual checkout and by a month for a monthly one', async () => {
    for (const [stored, interval] of [['annual', '1 year'], ['monthly', '1 month']]) {
      const pool = webhookPool(stored);
      const res = await send(createApp(env, pool, { billingProvider: provider() }), '/api/billing/subscription/webhook', rawEvent, { 'content-type': 'application/json', 'x-paystack-signature': signature });
      assert.equal(res.status, 200);
      assert.deepEqual(pool.state.subscriptionUpdates, [{ businessId: BIZ_A, planId: STARTER, interval }]);
    }
  });
});

describe('entitlements expose the period the current plan was bought for', () => {
  const poolFor = (subscription, lastPayment) => ({
    query: async (rawSql, values = []) => {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      if (sql.includes('FROM "SubscriptionPayments" WHERE "BusinessId"')) return { rows: lastPayment ? [lastPayment] : [] };
      if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: values[2] }] }; // entitlementValue; its subquery also mentions Subscriptions, so match it first
      if (sql.includes('FROM "Subscriptions" s')) return { rows: [subscription] };
      if (sql.includes('FROM "Plans" WHERE "Code"')) return { rows: [{ Id: PRO, Code: 'free', Name: 'Free' }] };
      if (sql.includes('"UsedBytes"')) return { rows: [{ UsedBytes: '0' }] };
      if (sql.includes('count(*)') || sql.includes('FROM "UsageCounters"')) return { rows: [{ Count: '0' }] };
      return { rows: [] };
    },
  });
  const active = { Status: 'Active', CurrentPeriodEndUtc: '2027-01-01T00:00:00Z', TrialStartedAtUtc: null, GraceEndsAtUtc: null, SuspendedAtUtc: null, PlanId: STARTER, Code: 'starter', Name: 'Starter', PendingPlanCode: null };
  it('reports annual or monthly for an active paid plan, and null otherwise', async () => {
    assert.equal((await getTenantEntitlements(poolFor(active, { BillingPeriod: 'annual' }), BIZ_A, {})).billingPeriod, 'annual');
    assert.equal((await getTenantEntitlements(poolFor(active, { BillingPeriod: 'monthly' }), BIZ_A, {})).billingPeriod, 'monthly');
    assert.equal((await getTenantEntitlements(poolFor(active, null), BIZ_A, {})).billingPeriod, null);
    assert.equal((await getTenantEntitlements(poolFor({ ...active, Status: 'PastDue' }, { BillingPeriod: 'annual' }), BIZ_A, {})).billingPeriod, null);
    assert.equal((await getTenantEntitlements(poolFor({ ...active, Code: 'free', Name: 'Free' }, { BillingPeriod: 'annual' }), BIZ_A, {})).billingPeriod, null);
  });
  it('ignores an unexpected period value', async () => {
    assert.equal(await lastPaidBillingPeriod({ query: async () => ({ rows: [{ BillingPeriod: 'weekly' }] }) }, BIZ_A, STARTER), null);
  });
});
