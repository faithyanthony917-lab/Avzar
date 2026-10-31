import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { createBillingProvider } from '../src/auth/billingProvider.js';
import { computeUpgradeCredit } from '../src/auth/subscriptionBillingService.js';
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
const headers = () => ({
  authorization: `Bearer ${issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: 10 }, { userId: USER, businessId: BIZ_A, sessionId: SESSION }).token}`,
  'content-type': 'application/json',
});

async function post(app, pathname, body) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const text = await response.text();
    let json = text; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

/** Fake Postgres: only what checkout, the permission gate and the entitlement summary touch. */
function makePool({ permissions = ['business.settings'], target, subscription = null, lastPayment = null } = {}) {
  const state = { payments: [] };
  async function query(rawSql, values = []) {
    const sql = rawSql.replace(/\s+/g, ' ').trim(); // services write multi-line SQL; match on its flattened text
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: USER, BusinessId: values[1], Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: permissions }] };
    if (sql.includes('FROM "Subscriptions" s JOIN "Plans" cp')) return { rows: subscription ? [subscription] : [] };
    if (sql.includes('FROM "Plans" WHERE "Code"')) return { rows: target && values[0] === target.Code ? [target] : [] };
    if (sql.includes('FROM "Businesses"')) return { rows: [{ ContactEmail: 'owner@example.test' }] };
    if (sql.includes('FROM "SubscriptionPayments" WHERE "BusinessId"')) return { rows: lastPayment ? [lastPayment] : [] };
    if (sql.includes('INSERT INTO "SubscriptionPayments"')) { state.payments.push({ amount: values[4], planId: values[2] }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  return { query, async connect() { return { query, release() {} }; }, state };
}
const fakeBilling = () => {
  const calls = [];
  return { ...createBillingProvider(env), calls, initialize: async (args) => { calls.push(args); return { authorizationUrl: `https://pay.example.test/${args.reference}` }; } };
};
const professional = { Id: PRO, Code: 'professional', CurrencyCode: 'NGN', MonthlyPrice: '10000.00', AnnualPrice: '100000.00' };
const activeStarter = (daysLeft) => ({ Status: 'Active', PlanId: STARTER, CurrentPeriodEndUtc: new Date(Date.now() + daysLeft * DAY).toISOString(), CurrentMonthlyPrice: '5000.00' });

describe('computeUpgradeCredit', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const inDays = (n) => new Date(now.getTime() + n * DAY);
  it('credits the unused share of the last payment in integer minor units', () => {
    assert.equal(computeUpgradeCredit({ paidMinor: 500_000, billingPeriod: 'monthly', periodEnd: inDays(15), now }), 250_000);
    assert.equal(computeUpgradeCredit({ paidMinor: 5_000_000, billingPeriod: 'annual', periodEnd: inDays(73), now }), 1_000_000);
    assert.equal(computeUpgradeCredit({ paidMinor: 100_001, billingPeriod: 'monthly', periodEnd: inDays(10), now }), 33_333); // rounds down
  });
  it('never credits more than the last payment, and nothing for a finished period or bad input', () => {
    assert.equal(computeUpgradeCredit({ paidMinor: 500_000, billingPeriod: 'monthly', periodEnd: inDays(90), now }), 500_000);
    assert.equal(computeUpgradeCredit({ paidMinor: 500_000, billingPeriod: 'monthly', periodEnd: inDays(-1), now }), 0);
    assert.equal(computeUpgradeCredit({ paidMinor: null, billingPeriod: 'monthly', periodEnd: inDays(5), now }), 0);
    assert.equal(computeUpgradeCredit({ paidMinor: 0, billingPeriod: 'monthly', periodEnd: inDays(5), now }), 0);
  });
});

describe('POST /api/billing/subscription/checkout plan changes', () => {
  const url = '/api/billing/subscription/checkout';
  const body = { planCode: 'professional', billingPeriod: 'monthly' };
  it('credits the unused part of the current payment when upgrading mid-period', async () => {
    const pool = makePool({ target: professional, subscription: activeStarter(15), lastPayment: { Amount: '5000.00', BillingPeriod: 'monthly' } });
    const billing = fakeBilling();
    const res = await post(createApp(env, pool, { billingProvider: billing }), url, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sent = billing.calls[0];
    assert.equal(sent.amountMinor + sent.metadata.creditMinor, 1_000_000, 'charge plus credit equals the plan price');
    assert.ok(sent.metadata.creditMinor > 240_000 && sent.metadata.creditMinor <= 250_000, `credit ${sent.metadata.creditMinor}`);
    assert.equal(res.body.amount, sent.amountMinor / 100);
    assert.equal(res.body.creditAmount, sent.metadata.creditMinor / 100);
    assert.equal(pool.state.payments[0].amount, (sent.amountMinor / 100).toFixed(2));
  });
  it('charges the full price when there is no running paid period', async () => {
    const pool = makePool({ target: professional, subscription: { Status: 'Active', PlanId: STARTER, CurrentPeriodEndUtc: null, CurrentMonthlyPrice: '0.00' } });
    const billing = fakeBilling();
    const res = await post(createApp(env, pool, { billingProvider: billing }), url, body);
    assert.equal(res.status, 200);
    assert.equal(billing.calls[0].amountMinor, 1_000_000);
    assert.equal(res.body.creditAmount, 0);
  });
  it('refuses to buy a cheaper plan mid-period; it must be scheduled for the period end', async () => {
    const pool = makePool({ target: { ...professional, Code: 'basic', Id: PRO, MonthlyPrice: '2000.00' }, subscription: activeStarter(15) });
    const res = await post(createApp(env, pool, { billingProvider: fakeBilling() }), url, { planCode: 'basic', billingPeriod: 'monthly' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'use_scheduled_downgrade');
    assert.equal(pool.state.payments.length, 0);
  });
  it('refuses an upgrade whose credit already covers the price', async () => {
    const pool = makePool({ target: professional, subscription: activeStarter(300), lastPayment: { Amount: '50000.00', BillingPeriod: 'annual' } });
    const res = await post(createApp(env, pool, { billingProvider: fakeBilling() }), url, body);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'upgrade_credit_exceeds_price');
    assert.equal(pool.state.payments.length, 0);
  });
});

describe('subscription lifecycle routes', () => {
  it('require the business.settings permission', async () => {
    const app = createApp(env, makePool({ permissions: [] }), { billingProvider: fakeBilling() });
    for (const path of ['/api/billing/subscription/trial', '/api/billing/subscription/change', '/api/billing/subscription/change/cancel']) {
      assert.equal((await post(app, path, { planCode: 'starter' })).status, 403, path);
    }
  });
  it('reject a missing plan code before touching the database', async () => {
    const app = createApp(env, makePool(), { billingProvider: fakeBilling() });
    const trial = await post(app, '/api/billing/subscription/trial', {});
    assert.equal(trial.status, 400);
    assert.equal(trial.body.code, 'invalid_plan');
    assert.equal((await post(app, '/api/billing/subscription/change', { planCode: '' })).status, 400);
  });
});

describe('getTenantEntitlements usage metering', () => {
  it('flags a usage figure above its plan limit and exposes the lifecycle state, without hiding anything', async () => {
    const pool = {
      query: async (sql, values = []) => {
        if (sql.includes('count(*)::bigint AS "Count" FROM "Memberships"')) return { rows: [{ Count: '5' }] };
        if (sql.includes('count(*)::bigint AS "Count" FROM "Invitations"')) return { rows: [{ Count: '0' }] };
        if (sql.includes('count(*)::bigint AS "Count" FROM "Customers"')) return { rows: [{ Count: '2' }] };
        if (sql.includes('count(*)::bigint AS "Count" FROM "Designs"')) return { rows: [{ Count: '3' }] };
        if (sql.includes('count(*)::bigint AS "Count" FROM "Storefronts"')) return { rows: [{ Count: '1' }] };
        if (sql.includes('"UsedBytes"')) return { rows: [{ UsedBytes: String(1_073_741_824 + 1) }] }; // one byte over 1 GB
        if (sql.includes('FROM "UsageCounters"')) return { rows: [] };
        if (sql.includes('FROM "Plans" p')) {
          const limits = { 'users.max': '1', 'customers.active.max': 'unlimited', 'designs.max': '3', 'storefront.count.max': '2', 'storage.gb.max': '1' };
          return { rows: [{ Value: limits[values[1]] ?? values[2] }] };
        }
        if (sql.includes('FROM "Subscriptions" s')) {
          return { rows: [{ Status: 'Expired', CurrentPeriodEndUtc: '2026-10-01T00:00:00Z', SuspendedAtUtc: '2026-10-10T00:00:00Z', TrialStartedAtUtc: null, GraceEndsAtUtc: null, PlanId: STARTER, Code: 'starter', Name: 'Starter', PendingPlanCode: null }] };
        }
        if (sql.includes('FROM "Plans" WHERE "Code"')) return { rows: [{ Id: PRO, Code: 'free', Name: 'Free' }] };
        return { rows: [] };
      },
    };
    const result = await getTenantEntitlements(pool, BIZ_A, { BILLING_TRIAL_DAYS: 14 });
    assert.equal(result.planCode, 'free');
    assert.equal(result.status, 'Expired');
    assert.equal(result.suspendedPlanCode, 'starter');
    assert.equal(result.suspendedAtUtc, '2026-10-10T00:00:00.000Z');
    assert.equal(result.canStartTrial, false);
    assert.equal(result.trialDays, 14);
    assert.equal(result.items.find((item) => item.key === 'users.max').overLimit, true);
    assert.equal(result.items.find((item) => item.key === 'customers.active.max').overLimit, false);
    // At the limit is not over it; one byte past the storage limit is, even though the displayed GB figure rounds to 1.
    const byKey = (key) => result.items.find((item) => item.key === key);
    assert.equal(byKey('designs.max').used, 3);
    assert.equal(byKey('designs.max').overLimit, false);
    assert.equal(byKey('storefront.count.max').used, 1);
    assert.equal(byKey('storefront.count.max').overLimit, false);
    assert.equal(byKey('storage.gb.max').used, 1);
    assert.equal(byKey('storage.gb.max').overLimit, true);
  });
});
