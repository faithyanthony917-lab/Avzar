// B2: the scheduled plan change (downgrade / cancel at period end) and its cancel route, over HTTP with a fake pool.
// The real-PostgreSQL happy paths live in test/db/subscriptionLifecycle.integration.test.js; this file pins the refusal rules,
// the response shapes and the exact writes, and needs no database.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { createBillingProvider } from '../src/auth/billingProvider.js';

const USER = '00000000-0000-4000-8000-000000000001';
const BIZ = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-000000000003';
const FREE = '00000000-0000-4000-8000-000000000007';
const STARTER = '00000000-0000-4000-8000-000000000008';
const PRO = '00000000-0000-4000-8000-000000000009';
const DAY = 86_400_000;
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
  BILLING_PAYSTACK_SECRET_KEY: 'sk_test_secret',
};
const headers = () => ({
  authorization: `Bearer ${issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: 10 }, { userId: USER, businessId: BIZ, sessionId: SESSION }).token}`,
  'content-type': 'application/json',
});

async function post(app, pathname, body) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
    const text = await response.text();
    let json = text; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

const plans = {
  free: { Id: FREE, Code: 'free', Name: 'Free', MonthlyPrice: '0.00' },
  starter: { Id: STARTER, Code: 'starter', Name: 'Starter', MonthlyPrice: '5000.00' },
  professional: { Id: PRO, Code: 'professional', Name: 'Professional', MonthlyPrice: '10000.00' },
};

/** Fake Postgres: the permission gate, the subscription row lock, the plan lookup, and a record of every write. */
function makePool(subscription) {
  const state = { writes: [] };
  async function query(rawSql, values = []) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: USER, BusinessId: values[1], Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: ['business.settings'] }] };
    if (sql.includes('FROM "Subscriptions" s JOIN "Plans" p') && sql.includes('FOR UPDATE OF s')) return { rows: subscription ? [subscription] : [] };
    if (sql.includes('FROM "Plans" WHERE "Code" = $1 AND "IsActive" = TRUE')) return { rows: plans[values[0]] ? [plans[values[0]]] : [] };
    if (/^UPDATE "Subscriptions" SET "PendingPlanId"/.test(sql)) { state.writes.push({ sql, values }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  return { query, async connect() { return { query, release() {} }; }, state };
}
const app = (pool) => createApp(env, pool, { billingProvider: createBillingProvider(env) });
const periodEnd = new Date(Date.now() + 20 * DAY).toISOString();
const paid = (over = {}) => ({ Id: 'sub-1', Status: 'Active', PlanId: PRO, PlanCode: 'professional', MonthlyPrice: '10000.00', CurrentPeriodEndUtc: periodEnd, TrialStartedAtUtc: null, PendingPlanId: null, ...over });
const CHANGE = '/api/billing/subscription/change';
const CANCEL = '/api/billing/subscription/change/cancel';

describe('POST /api/billing/subscription/change', () => {
  it('refuses when there is no paid, active subscription with a period end, and writes nothing', async () => {
    const cases = {
      'no subscription row': null,
      'on the Free plan': paid({ PlanId: FREE, PlanCode: 'free', MonthlyPrice: '0.00', CurrentPeriodEndUtc: null }),
      'trialling': paid({ Status: 'Trialing' }),
      'payment overdue': paid({ Status: 'PastDue' }),
      'suspended': paid({ Status: 'Expired' }),
      'no period end': paid({ CurrentPeriodEndUtc: null }),
    };
    for (const [label, row] of Object.entries(cases)) {
      const pool = makePool(row);
      const res = await post(app(pool), CHANGE, { planCode: 'starter' });
      assert.equal(res.status, 409, label);
      assert.equal(res.body.code, 'no_paid_subscription', label);
      assert.equal(pool.state.writes.length, 0, label);
    }
  });

  it('answers 404 for an unknown or inactive plan', async () => {
    const pool = makePool(paid());
    const res = await post(app(pool), CHANGE, { planCode: 'platinum' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'plan_not_found');
    assert.equal(pool.state.writes.length, 0);
  });

  it('refuses the plan the business is already on', async () => {
    const pool = makePool(paid());
    const res = await post(app(pool), CHANGE, { planCode: 'professional' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'same_plan');
    assert.equal(pool.state.writes.length, 0);
  });

  it('refuses a dearer plan, and an equally priced one: upgrades go through checkout', async () => {
    const dearer = makePool(paid({ PlanId: STARTER, PlanCode: 'starter', MonthlyPrice: '5000.00' }));
    const res = await post(app(dearer), CHANGE, { planCode: 'professional' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'use_checkout_for_upgrade');
    assert.equal(dearer.state.writes.length, 0);
    plans.starter.MonthlyPrice = '10000.00';
    try {
      const equal = makePool(paid());
      const same = await post(app(equal), CHANGE, { planCode: 'starter' });
      assert.equal(same.body.code, 'use_checkout_for_upgrade');
      assert.equal(equal.state.writes.length, 0);
    } finally { plans.starter.MonthlyPrice = '5000.00'; }
  });

  it('schedules a cheaper plan for the period end and reports when it takes effect', async () => {
    const pool = makePool(paid());
    const res = await post(app(pool), CHANGE, { planCode: 'starter' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { pendingPlanCode: 'starter', effectiveAtUtc: periodEnd });
    assert.equal(pool.state.writes.length, 1);
    assert.deepEqual(pool.state.writes[0].values, ['sub-1', STARTER]);
  });

  it('schedules Free (cancel at period end) without a price check', async () => {
    const pool = makePool(paid());
    const res = await post(app(pool), CHANGE, { planCode: 'free' });
    assert.equal(res.status, 200);
    assert.equal(res.body.pendingPlanCode, 'free');
    assert.deepEqual(pool.state.writes[0].values, ['sub-1', FREE]);
  });
});

describe('POST /api/billing/subscription/change/cancel', () => {
  it('refuses when nothing is scheduled', async () => {
    const pool = makePool(paid());
    const res = await post(app(pool), CANCEL);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_scheduled_change');
    assert.equal(pool.state.writes.length, 0);
  });

  it('refuses when the business has no subscription row at all', async () => {
    const res = await post(app(makePool(null)), CANCEL);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_scheduled_change');
  });

  it('clears a scheduled change and keeps the current plan', async () => {
    const pool = makePool(paid({ PendingPlanId: STARTER }));
    const res = await post(app(pool), CANCEL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { pendingPlanCode: null });
    assert.equal(pool.state.writes.length, 1);
    assert.deepEqual(pool.state.writes[0].values, ['sub-1']);
    assert.match(pool.state.writes[0].sql, /"PendingPlanId" = NULL/);
  });
});
