process.env.NODE_ENV = 'test';
process.env.AVZAR_NOW = '2026-10-27T12:00:00.000Z';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

// Step 15b: the installment-plan routes over HTTP with a pool that answers the exact statements the service sends.
// Covers permissions, validation, idempotency, the refusals, the per-invoice lock and the audit entries. It cannot prove isolation or
// the partial unique index: those are in test/db/installmentPlans.integration.test.js (restricted role, real PostgreSQL).

const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};
const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const invoiceId = '00000000-0000-4000-8000-000000000030';
const missingInvoiceId = '00000000-0000-4000-8000-000000000031';
const PLAN_URL = `/api/invoices/${invoiceId}/installment-plan`;

const token = () => issueAccessToken({
  jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
}, { userId, businessId, sessionId: '00000000-0000-4000-8000-000000000003' }).token;

async function call(app, method, pathname, body) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function makePool(permissions, overrides = {}) {
  const state = {
    invoice: { Id: invoiceId, Number: 'INV-2026-00001', CustomerId: 'c1', CurrencyCode: 'NGN', Status: 'Issued', Total: '100.00', AmountPaid: '0', AmountCredited: '0', LocationId: null },
    entitlement: 'true', plan: null, parts: [], inserts: [], audits: [], updates: [], locks: 0, ...overrides,
  };
  const membership = {
    UserId: userId, Email: 'staff@example.test', FullName: 'Staff', BusinessId: businessId, BusinessName: 'Shop', TimeZoneId: 'Africa/Lagos',
    CurrencyCode: 'NGN', IsOwner: false, Permissions: [...permissions, 'locations.all'],
  };
  const handle = async (sql, params = []) => {
    const text = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
    if (text.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (text.includes('JOIN "AspNetUsers"')) return { rows: [membership] };
    if (text.includes('pg_advisory_xact_lock')) { state.locks += 1; return { rows: [] }; }
    if (text.includes('finance.partial_payments')) return { rows: [{ Value: state.entitlement }] };
    if (text.includes('SELECT "TimeZoneId"')) return { rows: [{ TimeZoneId: 'Africa/Lagos' }] };
    if (text.includes('"InvoiceInstallmentPlans" pl') && text.includes('"InvoiceStatus"')) {
      return { rows: state.plan ? [{ ...state.plan, InvoiceStatus: state.invoice.Status, InvoiceTotal: state.invoice.Total, CurrencyCode: 'NGN',
        AmountPaid: state.invoice.AmountPaid, AmountCredited: state.invoice.AmountCredited }] : [] };
    }
    if (text.includes('"InvoiceInstallmentPlans" pl') && text.includes('"Scheduled"')) {
      return { rows: state.plan ? [{ Id: state.plan.Id, Scheduled: state.parts.reduce((s, p) => s + Number(p.Amount), 0).toFixed(2) }] : [] };
    }
    if (text.includes('FROM "InvoiceInstallments"')) return { rows: state.parts.map((p) => ({ ...p, PlanId: state.plan.Id })) };
    if (text.includes('FROM "Invoices" i')) return { rows: state.invoice && params[1] === state.invoice.Id ? [state.invoice] : [] };
    if (text.startsWith('INSERT INTO "InvoiceInstallmentPlans"') || text.trim().startsWith('INSERT INTO "InvoiceInstallmentPlans"')) {
      state.plan = { Id: params[0], BusinessId: params[1], InvoiceId: params[2], Status: 'Active', PaidAtCreation: params[3], CreditedAtCreation: params[4], Note: params[5], CreatedByUserId: params[6], CreatedAtUtc: new Date() };
      state.inserts.push(['plan', params]);
      return { rows: [], rowCount: 1 };
    }
    if (text.trim().startsWith('INSERT INTO "InvoiceInstallments"')) {
      state.parts.push({ Sequence: params[3], DueDate: params[4], Amount: params[5] });
      state.inserts.push(['installment', params]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "AuditLogs"')) { state.audits.push(params); return { rows: [], rowCount: 1 }; }
    if (text.includes('UPDATE "InvoiceInstallmentPlans"')) {
      state.updates.push(params);
      if (!state.plan) return { rows: [], rowCount: 0 };
      state.plan = null; state.parts = [];
      return { rows: [{ Id: 'p' }], rowCount: 1 };
    }
    return { rows: [] };
  };
  return { state, query: handle, connect: async () => ({ query: handle, release() {} }) };
}

const equal = { parts: 3, firstDueDate: '2026-11-01', interval: 'monthly' };
const amountsOf = (pool) => pool.state.inserts.filter(([kind]) => kind === 'installment').map(([, params]) => params[5]);

describe('installment plan routes', () => {
  it('needs payments.view to read and payments.record to make or cancel a plan', async () => {
    assert.equal((await call(createApp(env, makePool(['customers.view'])), 'GET', PLAN_URL)).status, 403);
    assert.equal((await call(createApp(env, makePool(['payments.view'])), 'POST', PLAN_URL, equal)).status, 403);
    assert.equal((await call(createApp(env, makePool(['payments.view'])), 'DELETE', PLAN_URL, {})).status, 403);
    const read = await call(createApp(env, makePool(['payments.view'])), 'GET', PLAN_URL);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { plan: null });
  });

  it('makes an equal-parts plan whose last part absorbs the rounding, under the per-invoice lock, with an audit entry', async () => {
    const pool = makePool(['payments.record']);
    const result = await call(createApp(env, pool), 'POST', PLAN_URL, equal);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.created, true);
    assert.deepEqual(amountsOf(pool), [33.33, 33.33, 33.34]);
    assert.deepEqual(pool.state.parts.map((p) => p.DueDate), ['2026-11-01', '2026-12-01', '2027-01-01']);
    assert.equal(pool.state.locks, 1);
    assert.equal(pool.state.audits.length, 1);
    assert.equal(pool.state.audits[0][1], 'invoice.installment_plan_created');
    assert.equal(result.body.plan.installments.length, 3);
    assert.equal(result.body.plan.outstanding, 100);
    assert.equal(result.body.plan.next.sequence, 1);
  });

  it('makes a custom plan that adds up to the balance', async () => {
    const pool = makePool(['payments.record']);
    const result = await call(createApp(env, pool), 'POST', PLAN_URL, { installments: [{ dueDate: '2026-11-01', amount: 70 }, { dueDate: '2026-12-01', amount: 30 }] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.deepEqual(amountsOf(pool), [70, 30]);
  });

  it('records what the invoice had already received, so only later money is read against the schedule', async () => {
    const pool = makePool(['payments.record'], { invoice: { Id: invoiceId, Number: 'INV-1', CustomerId: 'c1', CurrencyCode: 'NGN', Status: 'Issued', Total: '100.00', AmountPaid: '40.00', AmountCredited: '10.00', LocationId: null } });
    const result = await call(createApp(env, pool), 'POST', PLAN_URL, { parts: 2, firstDueDate: '2026-11-01', interval: 'weekly' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.deepEqual(amountsOf(pool), [25, 25]);
    const [, params] = pool.state.inserts[0];
    assert.equal(params[3], '40.00');
    assert.equal(params[4], '10.00');
    assert.equal(result.body.plan.outstanding, 50);
    assert.equal(result.body.plan.matchesInvoice, true);
  });

  it('answers a repeat of the same request with the existing plan and writes nothing new', async () => {
    const pool = makePool(['payments.record']);
    const app = createApp(env, pool);
    assert.equal((await call(app, 'POST', PLAN_URL, equal)).status, 201);
    const before = pool.state.inserts.length;
    const again = await call(app, 'POST', PLAN_URL, equal);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.created, false);
    assert.equal(pool.state.inserts.length, before);
    assert.equal(pool.state.audits.length, 1);
  });

  it('still recognises the repeat after a payment has changed the balance', async () => {
    const pool = makePool(['payments.record']);
    const app = createApp(env, pool);
    assert.equal((await call(app, 'POST', PLAN_URL, equal)).status, 201);
    pool.state.invoice.AmountPaid = '33.33';
    assert.equal((await call(app, 'POST', PLAN_URL, equal)).status, 200);
  });

  it('refuses a different plan while one is Active', async () => {
    const pool = makePool(['payments.record']);
    const app = createApp(env, pool);
    assert.equal((await call(app, 'POST', PLAN_URL, equal)).status, 201);
    const other = await call(app, 'POST', PLAN_URL, { ...equal, parts: 4 });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'installment_plan_exists');
  });

  it('validates the body', async () => {
    const app = createApp(env, makePool(['payments.record']));
    for (const body of [
      { ...equal, parts: 1 }, { ...equal, parts: 25 }, { ...equal, interval: 'daily' }, { ...equal, firstDueDate: '1 Nov' },
      { ...equal, extra: true }, {}, { installments: [{ dueDate: '2026-11-01', amount: 100 }] },
    ]) {
      const result = await call(app, 'POST', PLAN_URL, body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.code, 'validation_failed');
    }
    const mismatch = await call(app, 'POST', PLAN_URL, { installments: [{ dueDate: '2026-11-01', amount: 60 }, { dueDate: '2026-12-01', amount: 30 }] });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, 'installments_do_not_match_balance');
    assert.equal((await call(app, 'POST', PLAN_URL, { ...equal, firstDueDate: '2026-02-30' })).status, 400);
    assert.equal((await call(app, 'POST', PLAN_URL, { ...equal, firstDueDate: '2026-10-26' })).status, 400, 'a first due date in the past is refused');
    assert.equal((await call(app, 'POST', '/api/invoices/not-a-uuid/installment-plan', equal)).body.code, 'invalid_invoice_id');
  });

  it('refuses a draft or void invoice, a cleared balance, and a plan whose feature is off', async () => {
    const make = (patch, entitlement = 'true') => makePool(['payments.record'], { entitlement, invoice: { Id: invoiceId, Number: 'INV-1', CustomerId: 'c1', CurrencyCode: 'NGN', Status: 'Issued', Total: '100.00', AmountPaid: '0', AmountCredited: '0', LocationId: null, ...patch } });
    assert.equal((await call(createApp(env, make({ Status: 'Draft' })), 'POST', PLAN_URL, equal)).body.code, 'invoice_not_payable');
    assert.equal((await call(createApp(env, make({ Status: 'Void' })), 'POST', PLAN_URL, equal)).body.code, 'invoice_not_payable');
    assert.equal((await call(createApp(env, make({ AmountPaid: '100.00' })), 'POST', PLAN_URL, equal)).body.code, 'nothing_owed');
    assert.equal((await call(createApp(env, make({ AmountPaid: '60.00', AmountCredited: '40.00' })), 'POST', PLAN_URL, equal)).body.code, 'nothing_owed');
    const noFeature = await call(createApp(env, make({}, 'false')), 'POST', PLAN_URL, equal);
    assert.equal(noFeature.status, 403);
    assert.equal(noFeature.body.code, 'feature_not_in_plan');
  });

  it('gives an unknown invoice, such as another business\'s, a 404 on every route', async () => {
    const app = createApp(env, makePool(['payments.record', 'payments.view']));
    const url = `/api/invoices/${missingInvoiceId}/installment-plan`;
    assert.equal((await call(app, 'GET', url)).status, 404);
    assert.equal((await call(app, 'POST', url, equal)).status, 404);
    assert.equal((await call(app, 'DELETE', url, {})).status, 404);
  });

  it('cancels the Active plan with an audit entry, and a second cancel is a 404', async () => {
    const pool = makePool(['payments.record']);
    const app = createApp(env, pool);
    assert.equal((await call(app, 'POST', PLAN_URL, equal)).status, 201);
    const cancelled = await call(app, 'DELETE', PLAN_URL, { reason: 'Customer paid in full by cash' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.deepEqual(cancelled.body, { cancelled: true });
    assert.equal(pool.state.audits.at(-1)[1], 'invoice.installment_plan_cancelled');
    const again = await call(app, 'DELETE', PLAN_URL, {});
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'installment_plan_not_found');
    assert.equal((await call(app, 'DELETE', PLAN_URL, { reason: 'x'.repeat(201) })).status, 400);
  });

  it('shows the schedule read against what the invoice has since received', async () => {
    const pool = makePool(['payments.record', 'payments.view']);
    const app = createApp(env, pool);
    assert.equal((await call(app, 'POST', PLAN_URL, equal)).status, 201);
    pool.state.invoice.AmountPaid = '50.00';
    const read = await call(app, 'GET', PLAN_URL);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.plan.installments.map((r) => r.status), ['Paid', 'PartPaid', 'Due']);
    assert.equal(read.body.plan.next.amount, 16.66);
    assert.equal(read.body.plan.next.payAmount, 16.66);
    assert.equal(read.body.plan.invoiceBalance, 50);
    assert.equal(read.body.plan.state, 'Active');
    pool.state.invoice.AmountPaid = '100.00';
    const done = await call(app, 'GET', PLAN_URL);
    assert.equal(done.body.plan.state, 'Completed');
    assert.equal(done.body.plan.next, null);
  });
});
