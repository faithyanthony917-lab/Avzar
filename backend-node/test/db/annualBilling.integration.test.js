// B2: annual billing against a real PostgreSQL built only from the Node migrations (skipped unless DATABASE_URL is set, CI job "node-db").
// subscriptionLifecycle.integration.test.js covers monthly payments; this covers what is specific to the annual period:
// the seeded plans carry no annual price, a monthly -> annual switch stacks the year after the paid time, replaying the webhook
// does not extend it twice, and annual -> monthly is refused while the annual period runs.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/http/app.js';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { toMinorUnits } from '../../src/auth/subscriptionBillingService.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const PASSWORD = 'correct horse battery staple';
const DAY = 86_400_000;
const WEBHOOK = '/api/billing/subscription/webhook';

function startApp(pool) {
  const env = loadEnv({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars',
    WEB_BASE_URL: 'https://app.example.test', STORAGE_LOCAL_ROOT: path.join(os.tmpdir(), 'avzar-annual-media'),
    BILLING_PAYSTACK_SECRET_KEY: 'sk_test_annual', BILLING_ACTION_RATE_LIMIT_PER_MINUTE: '1000',
  });
  const billingProvider = {
    isConfigured: () => true,
    initialize: async ({ reference }) => ({ authorizationUrl: `https://pay.example.test/${reference}` }),
    verify: async (reference) => {
      const { rows } = await pool.query('SELECT "Amount" FROM "SubscriptionPayments" WHERE "ProviderReference" = $1', [reference]);
      return { status: 'success', reference, currency: 'NGN', amountMinor: toMinorUnits(rows[0].Amount) };
    },
    verifySignature: (_raw, signature) => signature === 'valid',
  };
  const app = createApp(env, pool, { billingProvider });
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, pathname, { token, body } = {}) => {
      let csrf = {};
      if (!token && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const issued = await (await fetch(`${base}/api/auth/csrf`)).json();
        csrf = { cookie: `tailoring.csrf=${issued.token}`, 'x-xsrf-token': issued.token };
      }
      const response = await fetch(base + pathname, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: json, text };
    };
    const webhook = (reference) => fetch(base + WEBHOOK, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': 'valid' },
      body: JSON.stringify({ event: 'charge.success', data: { reference } }),
    });
    resolve({ call, webhook, close: () => new Promise((done) => { app.locals.objectStorage.close(); server.close(done); }) });
  }));
}

async function signUp(api, pool, label) {
  const email = `${label}-${Date.now()}@example.test`;
  const registered = await api.call('POST', '/api/auth/register-business', {
    body: { businessName: `${label} Tailors`, ownerName: `${label} Owner`, email, password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
  assert.equal(registered.status, 201, registered.text);
  const login = await api.call('POST', '/api/auth/token', { body: { email, password: PASSWORD, deviceName: 'integration' } });
  assert.equal(login.status, 200, login.text);
  const businessId = login.body.user.businessId;
  await pool.query('UPDATE "Businesses" SET "ContactEmail" = $2 WHERE "Id" = $1', [businessId, email]);
  return { email, token: login.body.accessToken, businessId };
}

describe('annual billing on a database built only from the Node migrations', { skip: !url }, () => {
  let db; let api; let cy;

  const subscription = async () => (await db.pool.query(`
    SELECT s.*, p."Code" AS "PlanCode" FROM "Subscriptions" s JOIN "Plans" p ON p."Id" = s."PlanId" WHERE s."BusinessId" = $1`, [cy.businessId])).rows[0];
  const entitlements = async () => (await api.call('GET', '/api/billing/entitlements', { token: cy.token })).body;
  const checkout = (planCode, billingPeriod) => api.call('POST', '/api/billing/subscription/checkout', { token: cy.token, body: { planCode, billingPeriod } });
  const paymentCount = async () => (await db.pool.query('SELECT count(*)::int AS n FROM "SubscriptionPayments" WHERE "BusinessId" = $1', [cy.businessId])).rows[0].n;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_annual');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
    cy = await signUp(api, db.pool, 'cy');
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('the seeded plans have no annual price, so annual checkout is refused until a price is set', async () => {
    const { rows } = await db.pool.query(`SELECT "AnnualPrice" FROM "Plans" WHERE "Code" = 'starter'`);
    assert.equal(rows[0].AnnualPrice, null);
    const refused = await checkout('starter', 'annual');
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'invalid_plan_price');
    assert.equal(await paymentCount(), 0, 'a refused checkout leaves no payment row');
    await db.pool.query(`UPDATE "Plans" SET "AnnualPrice" = '50000.00' WHERE "Code" = 'starter'`);
  });

  it('monthly -> annual on the same plan charges the full annual price and stacks the year after the paid month', async () => {
    const monthly = await checkout('starter', 'monthly');
    assert.equal(monthly.status, 200, monthly.text);
    assert.equal((await api.webhook(monthly.body.reference)).status, 200);
    const first = await subscription();
    assert.equal(first.PlanCode, 'starter');
    assert.equal((await entitlements()).billingPeriod, 'monthly');

    const annual = await checkout('starter', 'annual');
    assert.equal(annual.status, 200, annual.text);
    assert.equal(annual.body.creditAmount, 0, 'same plan: no credit');
    assert.equal(annual.body.amount, 50_000);
    assert.equal((await api.webhook(annual.body.reference)).status, 200);

    const second = await subscription();
    assert.equal(second.Status, 'Active');
    assert.equal(second.PlanCode, 'starter');
    const added = (second.CurrentPeriodEndUtc.getTime() - first.CurrentPeriodEndUtc.getTime()) / DAY;
    assert.ok(added >= 364.9 && added <= 366.1, `the year is added after the existing paid time, got ${added} days`);
    assert.equal((await entitlements()).billingPeriod, 'annual');
  });

  it('replaying the annual webhook does not extend the subscription again', async () => {
    const before = await subscription();
    const { rows } = await db.pool.query(`SELECT "ProviderReference" FROM "SubscriptionPayments" WHERE "BusinessId" = $1 AND "BillingPeriod" = 'annual'`, [cy.businessId]);
    assert.equal(rows.length, 1);
    assert.equal((await api.webhook(rows[0].ProviderReference)).status, 200);
    assert.equal((await subscription()).CurrentPeriodEndUtc.getTime(), before.CurrentPeriodEndUtc.getTime());
    const audit = await db.pool.query(`SELECT count(*)::int AS n FROM "AuditLogs" WHERE "BusinessId" = $1 AND "Action" = 'subscription.payment_applied'`, [cy.businessId]);
    assert.equal(audit.rows[0].n, 2, 'one audit row per applied payment: the monthly one and the annual one');
  });

  it('annual -> monthly is refused while the annual period runs, and creates no payment', async () => {
    const payments = await paymentCount();
    const refused = await checkout('starter', 'monthly');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'monthly_after_annual');
    assert.equal(await paymentCount(), payments);
    // Renewing on annual is still allowed.
    const renew = await checkout('starter', 'annual');
    assert.equal(renew.status, 200, renew.text);
  });

  it('monthly is allowed again once the annual period has ended', async () => {
    await db.pool.query(`UPDATE "Subscriptions" SET "CurrentPeriodEndUtc" = now() - interval '1 day' WHERE "BusinessId" = $1`, [cy.businessId]);
    const monthly = await checkout('starter', 'monthly');
    assert.equal(monthly.status, 200, monthly.text);
  });
});
