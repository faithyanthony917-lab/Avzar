// Step 02: subscription lifecycle against a real PostgreSQL built only from the Node migrations. Covers what the SQL-substring mocks cannot see:
// the real webhook UPDATE, trial rules, scheduled changes, the time-driven sweep, suspension without data loss, and tenant isolation.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/http/app.js';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { runLifecycleSweep } from '../../src/auth/subscriptionLifecycleService.js';
import { toMinorUnits } from '../../src/auth/subscriptionBillingService.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const PASSWORD = 'correct horse battery staple';
const DAY = 86_400_000;
const WEBHOOK = '/api/billing/subscription/webhook';

function startApp(pool) {
  const env = loadEnv({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars',
    WEB_BASE_URL: 'https://app.example.test', STORAGE_LOCAL_ROOT: path.join(os.tmpdir(), 'avzar-lifecycle-media'),
    BILLING_PAYSTACK_SECRET_KEY: 'sk_test_lifecycle',
    // The suite makes far more than 10 billing calls from one address in a minute; production keeps the default of 10.
    BILLING_ACTION_RATE_LIMIT_PER_MINUTE: '1000',
  });
  // Fake provider: the real verification rules in the service still run, only the network calls are replaced.
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

describe('subscription lifecycle on a database built only from the Node migrations', { skip: !url }, () => {
  let db; let api; let ade; let bola;

  const subscription = async (businessId) => (await db.pool.query(`
    SELECT s.*, p."Code" AS "PlanCode", pp."Code" AS "PendingCode" FROM "Subscriptions" s JOIN "Plans" p ON p."Id" = s."PlanId"
    LEFT JOIN "Plans" pp ON pp."Id" = s."PendingPlanId" WHERE s."BusinessId" = $1`, [businessId])).rows[0];
  const entitlements = async (owner) => (await api.call('GET', '/api/billing/entitlements', { token: owner.token })).body;
  const pay = async (owner, planCode, billingPeriod = 'monthly') => {
    const checkout = await api.call('POST', '/api/billing/subscription/checkout', { token: owner.token, body: { planCode, billingPeriod } });
    assert.equal(checkout.status, 200, checkout.text);
    assert.equal((await api.webhook(checkout.body.reference)).status, 200);
    return checkout.body;
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_lifecycle');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
    ade = await signUp(api, db.pool, 'ade');
    bola = await signUp(api, db.pool, 'bola');
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('a new business is on Free, may start a trial, and sees its lifecycle state', async () => {
    const e = await entitlements(ade);
    assert.equal(e.planCode, 'free');
    assert.equal(e.status, 'Active');
    assert.equal(e.canStartTrial, true);
    assert.equal(e.trialDays, 14);
    assert.equal(e.pendingPlanCode, null);
  });

  it('starts one trial of a paid plan, with the paid entitlements, and rejects bad requests', async () => {
    assert.equal((await api.call('POST', '/api/billing/subscription/trial', { token: ade.token, body: { planCode: 'free' } })).status, 400);
    assert.equal((await api.call('POST', '/api/billing/subscription/trial', { token: ade.token, body: { planCode: 'nope' } })).status, 404);
    const started = await api.call('POST', '/api/billing/subscription/trial', { token: ade.token, body: { planCode: 'professional' } });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.body.status, 'Trialing');
    const ends = new Date(started.body.trialEndsAtUtc).getTime() - Date.now();
    assert.ok(ends > 13 * DAY && ends <= 14 * DAY, `trial length ${ends / DAY} days`);
    const e = await entitlements(ade);
    assert.equal(e.planCode, 'professional');
    assert.equal(e.status, 'Trialing');
    assert.ok(e.trialEndsAtUtc);
    assert.equal(e.canStartTrial, false);
    assert.equal((await api.call('POST', '/api/billing/subscription/trial', { token: ade.token, body: { planCode: 'starter' } })).body.code, 'trial_not_available');
  });

  it('is isolated per business: another tenant is untouched and cannot change a plan it does not have', async () => {
    assert.equal((await subscription(bola.businessId)).PlanCode, 'free');
    assert.equal((await entitlements(bola)).canStartTrial, true);
    const change = await api.call('POST', '/api/billing/subscription/change', { token: bola.token, body: { planCode: 'free' } });
    assert.equal(change.status, 409);
    assert.equal(change.body.code, 'no_paid_subscription');
    assert.equal((await api.call('POST', '/api/billing/subscription/change/cancel', { token: bola.token })).body.code, 'no_scheduled_change');
    // a body naming another business is ignored: the token decides
    await api.call('POST', '/api/billing/subscription/trial', { token: bola.token, body: { planCode: 'starter', businessId: ade.businessId } });
    assert.equal((await subscription(ade.businessId)).PlanCode, 'professional');
    assert.equal((await subscription(bola.businessId)).PlanCode, 'starter');
  });

  it('an ended trial falls back to Free and a second trial is refused', async () => {
    await db.pool.query(`UPDATE "Subscriptions" SET "CurrentPeriodEndUtc" = now() - interval '1 minute' WHERE "BusinessId" = $1`, [ade.businessId]);
    const result = await runLifecycleSweep(db.pool);
    assert.deepEqual(result.events.filter((event) => event.businessId === ade.businessId).map((event) => event.event), ['trial_ended']);
    const row = await subscription(ade.businessId);
    assert.equal(row.PlanCode, 'free');
    assert.equal(row.Status, 'Active');
    assert.equal(row.CurrentPeriodEndUtc, null);
    assert.ok(row.TrialStartedAtUtc);
    const notices = await db.pool.query(`
      SELECT notification."EventType", membership."IsOwner"
      FROM "Notifications" notification
      JOIN "Memberships" membership ON membership."Id" = notification."RecipientMembershipId"
        AND membership."BusinessId" = notification."BusinessId"
      WHERE notification."BusinessId" = $1 AND notification."EventType" = 'subscription.trial_ended'`, [ade.businessId]);
    assert.deepEqual(notices.rows, [{ EventType: 'subscription.trial_ended', IsOwner: true }]);
    assert.equal((await runLifecycleSweep(db.pool)).events.filter((event) => event.businessId === ade.businessId).length, 0);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "Notifications" WHERE "BusinessId" = $1 AND "EventType" = 'subscription.trial_ended'`, [ade.businessId])).rows[0].n, 1);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "Notifications" WHERE "BusinessId" = $1 AND "EventType" = 'subscription.trial_ended'`, [bola.businessId])).rows[0].n, 0);
    assert.equal((await subscription(bola.businessId)).Status, 'Trialing', 'an unexpired trial of another business is not touched');
    assert.equal((await api.call('POST', '/api/billing/subscription/trial', { token: ade.token, body: { planCode: 'professional' } })).body.code, 'trial_already_used');
    assert.equal((await entitlements(ade)).canStartTrial, false);
  });

  it('a verified payment activates the plan once; replaying the webhook does not extend it again', async () => {
    const checkout = await api.call('POST', '/api/billing/subscription/checkout', { token: ade.token, body: { planCode: 'starter', billingPeriod: 'monthly' } });
    assert.equal(checkout.status, 200, checkout.text);
    assert.equal(checkout.body.creditAmount, 0);
    assert.equal((await api.webhook(checkout.body.reference)).status, 200);
    const first = await subscription(ade.businessId);
    assert.equal(first.PlanCode, 'starter');
    assert.equal(first.Status, 'Active');
    const remaining = first.CurrentPeriodEndUtc.getTime() - Date.now();
    assert.ok(remaining > 27 * DAY && remaining < 32 * DAY, `period ${remaining / DAY} days`);
    assert.equal((await api.webhook(checkout.body.reference)).status, 200);
    assert.equal((await subscription(ade.businessId)).CurrentPeriodEndUtc.getTime(), first.CurrentPeriodEndUtc.getTime());
    const audit = await db.pool.query(`SELECT count(*)::int AS n FROM "AuditLogs" WHERE "BusinessId" = $1 AND "Action" = 'subscription.payment_applied'`, [ade.businessId]);
    assert.equal(audit.rows[0].n, 1);
  });

  it('upgrades immediately with a prorated credit and a fresh period, not a stacked one', async () => {
    const checkout = await api.call('POST', '/api/billing/subscription/checkout', { token: ade.token, body: { planCode: 'professional', billingPeriod: 'monthly' } });
    assert.equal(checkout.status, 200, checkout.text);
    assert.ok(checkout.body.creditAmount > 4_000 && checkout.body.creditAmount <= 5_000, `credit ${checkout.body.creditAmount}`);
    assert.equal(Math.round((checkout.body.amount + checkout.body.creditAmount) * 100), 1_000_000);
    assert.equal((await api.webhook(checkout.body.reference)).status, 200);
    const row = await subscription(ade.businessId);
    assert.equal(row.PlanCode, 'professional');
    const remaining = row.CurrentPeriodEndUtc.getTime() - Date.now();
    assert.ok(remaining > 27 * DAY && remaining < 32 * DAY, `new period ${remaining / DAY} days, not stacked`);
  });

  it('a cheaper plan is scheduled for the period end, never bought mid-period', async () => {
    const refused = await api.call('POST', '/api/billing/subscription/checkout', { token: ade.token, body: { planCode: 'starter', billingPeriod: 'monthly' } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'use_scheduled_downgrade');
    assert.equal((await api.call('POST', '/api/billing/subscription/change', { token: ade.token, body: { planCode: 'business' } })).body.code, 'use_checkout_for_upgrade');
    assert.equal((await api.call('POST', '/api/billing/subscription/change', { token: ade.token, body: { planCode: 'professional' } })).body.code, 'same_plan');
    const scheduled = await api.call('POST', '/api/billing/subscription/change', { token: ade.token, body: { planCode: 'starter' } });
    assert.equal(scheduled.status, 200, scheduled.text);
    assert.equal(scheduled.body.pendingPlanCode, 'starter');
    const e = await entitlements(ade);
    assert.equal(e.planCode, 'professional', 'paid access continues until the period ends');
    assert.equal(e.pendingPlanCode, 'starter');
    assert.equal((await api.call('POST', '/api/billing/subscription/change/cancel', { token: ade.token })).status, 200);
    assert.equal((await entitlements(ade)).pendingPlanCode, null);
    assert.equal((await api.call('POST', '/api/billing/subscription/change/cancel', { token: ade.token })).body.code, 'no_scheduled_change');
    await api.call('POST', '/api/billing/subscription/change', { token: ade.token, body: { planCode: 'starter' } });
  });

  it('unpaid renewal: grace period keeps paid access, then suspension applies Free limits and deletes nothing', async () => {
    const customer = await api.call('POST', '/api/customers', { token: ade.token, body: { fullName: 'Tunde Bello', email: 'tunde@example.test', phone: '+2348012345678' } });
    assert.equal(customer.status, 201, customer.text);
    const counts = async () => (await db.pool.query(`
      SELECT (SELECT count(*) FROM "Customers" WHERE "BusinessId" = $1)::int AS customers,
             (SELECT count(*) FROM "Locations" WHERE "BusinessId" = $1)::int AS locations,
             (SELECT count(*) FROM "Memberships" WHERE "BusinessId" = $1)::int AS memberships`, [ade.businessId])).rows[0];
    const before = await counts();

    await db.pool.query(`UPDATE "Subscriptions" SET "CurrentPeriodEndUtc" = now() - interval '1 minute' WHERE "BusinessId" = $1`, [ade.businessId]);
    const overdue = await runLifecycleSweep(db.pool, { graceDays: 7 });
    assert.deepEqual(overdue.events.filter((event) => event.businessId === ade.businessId).map((event) => event.event), ['payment_overdue']);
    let row = await subscription(ade.businessId);
    assert.equal(row.Status, 'PastDue');
    assert.equal(row.PlanCode, 'starter', 'the scheduled lower plan is the one to renew');
    assert.equal(row.PendingPlanId, null);
    const grace = row.GraceEndsAtUtc.getTime() - row.CurrentPeriodEndUtc.getTime();
    assert.equal(grace, 7 * DAY);
    let e = await entitlements(ade);
    assert.equal(e.status, 'PastDue');
    assert.equal(e.planCode, 'starter', 'paid access continues during the grace period');
    assert.ok(e.graceEndsAtUtc);

    assert.equal((await runLifecycleSweep(db.pool, { graceDays: 7 })).events.filter((event) => event.businessId === ade.businessId).length, 0, 'running the sweep again changes nothing');

    const later = await runLifecycleSweep(db.pool, { graceDays: 7, now: new Date(Date.now() + 8 * DAY) });
    assert.deepEqual(later.events.filter((event) => event.businessId === ade.businessId).map((event) => event.event), ['subscription_suspended']);
    row = await subscription(ade.businessId);
    assert.equal(row.Status, 'Expired');
    assert.ok(row.SuspendedAtUtc);
    e = await entitlements(ade);
    assert.equal(e.planCode, 'free');
    assert.equal(e.status, 'Expired');
    assert.equal(e.suspendedPlanCode, 'starter');
    assert.deepEqual(await counts(), before, 'suspension deletes no records');
    const stillThere = await api.call('GET', `/api/customers/${customer.body.id}`, { token: ade.token });
    assert.equal(stillThere.status, 200, 'existing data stays readable');
    assert.equal((await runLifecycleSweep(db.pool, { graceDays: 7, now: new Date(Date.now() + 9 * DAY) })).events.filter((event) => event.businessId === ade.businessId).length, 0);
  });

  it('paying a suspended subscription restores it and clears the grace and suspension markers', async () => {
    await pay(ade, 'starter');
    const row = await subscription(ade.businessId);
    assert.equal(row.Status, 'Active');
    assert.equal(row.PlanCode, 'starter');
    assert.equal(row.GraceEndsAtUtc, null);
    assert.equal(row.SuspendedAtUtc, null);
    const e = await entitlements(ade);
    assert.equal(e.planCode, 'starter');
    assert.equal(e.suspendedPlanCode, null);
  });

  it('a scheduled cancel moves a paid subscription to Free at period end, keeping the data', async () => {
    assert.equal((await api.call('POST', '/api/billing/subscription/change', { token: ade.token, body: { planCode: 'free' } })).status, 200);
    await db.pool.query(`UPDATE "Subscriptions" SET "CurrentPeriodEndUtc" = now() - interval '1 minute' WHERE "BusinessId" = $1`, [ade.businessId]);
    const result = await runLifecycleSweep(db.pool);
    assert.deepEqual(result.events.filter((event) => event.businessId === ade.businessId).map((event) => event.event), ['subscription_ended']);
    const row = await subscription(ade.businessId);
    assert.equal(row.PlanCode, 'free');
    assert.equal(row.Status, 'Active');
    assert.equal(row.CurrentPeriodEndUtc, null);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "Customers" WHERE "BusinessId" = $1', [ade.businessId])).rows[0].n, 1);
  });
});
