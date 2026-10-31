// Step 15b: installment plans over HTTP on real PostgreSQL, through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: a plan is only a schedule (no payment, no change to the invoice); another business gets 404 on every route and sees no rows;
// a location-limited user gets 404 for an invoice outside their locations; one Active plan per invoice (the partial unique index);
// the schedule is read against verified payments and credit notes, oldest installment first; voiding the invoice ends the plan; the
// portal shows the schedule to the customer who owns the invoice, and "pay next installment" asks the provider for exactly the amount
// still owed on the next installment. A fake provider stands in for Paystack (unverified with live credentials).
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const code = (result) => result.body?.code ?? result.body?.error?.code;

describe('installment plans on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let viewer; let limited; let mine; let theirs; let portalToken;
  const started = [];
  const provider = {
    isConfigured: () => true,
    verifySignature: () => true,
    async initialize(args) { started.push(args); return { authorizationUrl: `https://checkout.example/${args.reference}` }; },
    async verify(reference) { const sent = started.find((s) => s.reference === reference); return { status: 'success', reference, currency: sent.currency, amountMinor: sent.amountMinor }; },
    async createSubaccount() { return { subaccountCode: 'ACCT_installments', accountName: 'TEST' }; },
    async listBanks() { return []; },
  };
  const count = async (sql, params) => Number((await db.pool.query(sql, params)).rows[0].n);
  const planUrl = (id) => `/api/invoices/${id}/installment-plan`;
  const issuedInvoice = async (who, label) => {
    const order = await confirmedOrder(api, db, who, await firstLocationId(db, who.businessId), label);
    const draft = await api.call('POST', `/api/invoices/from-order/${order.orderId}`, { token: who.token, body: { mode: 'Full' } });
    assert.equal(draft.status, 201, draft.text);
    assert.equal((await api.call('POST', `/api/invoices/${draft.body.id}/issue`, { token: who.token })).status, 200);
    return { invoiceId: draft.body.id, total: draft.body.total, customerId: order.customerId };
  };
  const makePlan = (who, id, body = { parts: 4, firstDueDate: '2099-01-01', interval: 'monthly' }) =>
    api.call('POST', planUrl(id), { token: who.token, body });
  const recordPayment = async (id, amount) => {
    const payment = await api.call('POST', `/api/invoices/${id}/payments`, { token: owner.token, body: { amount, method: 'BankTransfer', reference: `TRF-${randomBytes(3).toString('hex')}` }, headers: { 'idempotency-key': `pay-${randomBytes(6).toString('hex')}` } });
    assert.equal(payment.status, 201, payment.text);
    assert.equal((await api.call('POST', `/api/payments/${payment.body.id}/verify`, { token: owner.token })).status, 200);
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_inst');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool, {}, { billingProvider: provider });
    owner = await signUp(api, 'in-owner');
    other = await signUp(api, 'in-other');
    await upgradePlan(db, owner.businessId, 'starter');
    await upgradePlan(db, other.businessId, 'starter');
    viewer = await addStaff(api, db, owner, 'in-viewer', ['payments.view', 'locations.all']);
    limited = await addStaff(api, db, owner, 'in-limited', ['payments.view', 'payments.record']);
    mine = await issuedInvoice(owner, 'ina');
    theirs = await issuedInvoice(other, 'inb');
    const email = (await db.pool.query(`SELECT "TextBody" FROM "EmailOutbox" WHERE "BusinessId" = $1 AND "TemplateKey" = 'quotation_sent' ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [owner.businessId])).rows[0];
    portalToken = /customer-portal#([A-Za-z0-9_-]+)/.exec(email.TextBody)?.[1];
    assert.ok(portalToken);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('a viewer reads but cannot make a plan; a plan on the Free plan is refused', async () => {
    assert.equal((await makePlan(viewer, mine.invoiceId)).status, 403);
    assert.deepEqual((await api.call('GET', planUrl(mine.invoiceId), { token: viewer.token })).body, { plan: null });
    await upgradePlan(db, owner.businessId, 'free');
    const refused = await makePlan(owner, mine.invoiceId);
    assert.equal(refused.status, 403);
    assert.equal(code(refused), 'feature_not_in_plan');
    await upgradePlan(db, owner.businessId, 'starter');
    assert.equal(await count(`SELECT count(*) AS n FROM "InvoiceInstallmentPlans"`), 0);
  });

  it('makes a plan that adds up to the balance and holds no money', async () => {
    const before = await count(`SELECT count(*) AS n FROM "Payments" WHERE "InvoiceId" = $1`, [mine.invoiceId]);
    const result = await makePlan(owner, mine.invoiceId);
    assert.equal(result.status, 201, result.text);
    const sum = result.body.plan.installments.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    assert.equal(sum, Math.round(mine.total * 100));
    assert.equal(result.body.plan.installments.length, 4);
    assert.equal(result.body.plan.outstanding, mine.total);
    assert.equal(await count(`SELECT count(*) AS n FROM "Payments" WHERE "InvoiceId" = $1`, [mine.invoiceId]), before, 'no payment is made by a plan');
    assert.equal(await count(`SELECT count(*) AS n FROM "AuditLogs" WHERE "Action" = 'invoice.installment_plan_created' AND "EntityId" = $1`, [mine.invoiceId]), 1);
  });

  it('answers a repeat with the same plan, refuses a different one, and the database allows only one Active plan per invoice', async () => {
    const first = (await api.call('GET', planUrl(mine.invoiceId), { token: viewer.token })).body.plan;
    const again = await makePlan(owner, mine.invoiceId);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.plan.id, first.id);
    const different = await makePlan(owner, mine.invoiceId, { parts: 3, firstDueDate: '2099-01-01', interval: 'monthly' });
    assert.equal(different.status, 409);
    assert.equal(code(different), 'installment_plan_exists');
    assert.equal(await count(`SELECT count(*) AS n FROM "InvoiceInstallmentPlans" WHERE "InvoiceId" = $1 AND "Status" = 'Active'`, [mine.invoiceId]), 1);
    await assert.rejects(
      db.pool.query(`INSERT INTO "InvoiceInstallmentPlans" ("Id", "BusinessId", "InvoiceId") VALUES (gen_random_uuid(), $1, $2)`, [owner.businessId, mine.invoiceId]),
      { code: '23505' });
  });

  it('another business gets 404 on every route and has no rows; with no business context the restricted role sees nothing', async () => {
    assert.equal((await api.call('GET', planUrl(mine.invoiceId), { token: other.token })).status, 404);
    assert.equal((await makePlan(other, mine.invoiceId)).status, 404);
    assert.equal((await api.call('DELETE', planUrl(mine.invoiceId), { token: other.token, body: {} })).status, 404);
    assert.equal((await makePlan(owner, theirs.invoiceId)).status, 404);
    assert.equal(await count(`SELECT count(*) AS n FROM "InvoiceInstallmentPlans" WHERE "BusinessId" = $1`, [other.businessId]), 0);
    assert.equal(Number((await role.pool.query('SELECT count(*)::int AS n FROM "InvoiceInstallmentPlans"')).rows[0].n), 0);
    assert.equal(Number((await role.pool.query('SELECT count(*)::int AS n FROM "InvoiceInstallments"')).rows[0].n), 0);
  });

  it('a location-limited user gets 404 for an invoice outside their locations', async () => {
    assert.equal((await api.call('GET', planUrl(mine.invoiceId), { token: limited.token })).status, 404);
    assert.equal((await makePlan(limited, mine.invoiceId)).status, 404);
    assert.equal((await api.call('DELETE', planUrl(mine.invoiceId), { token: limited.token, body: {} })).status, 404);
  });

  it('reads the schedule against verified payments (oldest first) and credit notes (latest first)', async () => {
    const plan = (await api.call('GET', planUrl(mine.invoiceId), { token: owner.token })).body.plan;
    const [first, second] = plan.installments;
    await recordPayment(mine.invoiceId, first.amount + 1);
    let read = (await api.call('GET', planUrl(mine.invoiceId), { token: owner.token })).body.plan;
    assert.deepEqual(read.installments.slice(0, 2).map((r) => r.status), ['Paid', 'PartPaid']);
    assert.equal(read.next.sequence, 2);
    assert.equal(Math.round(read.next.amount * 100), Math.round((second.amount - 1) * 100));
    const credit = await api.call('POST', `/api/invoices/${mine.invoiceId}/credit-notes`, { token: owner.token, body: { amount: plan.installments[3].amount, reason: 'Goodwill credit' } });
    assert.equal(credit.status, 200, credit.text);
    read = (await api.call('GET', planUrl(mine.invoiceId), { token: owner.token })).body.plan;
    assert.equal(read.installments[3].status, 'Credited', 'a credit shrinks the latest installment');
    assert.equal(read.matchesInvoice, true);
    assert.equal(read.state, 'Active');
  });

  it('the portal shows the schedule to the customer, and pay next installment asks the provider for exactly the next amount', async () => {
    await db.pool.query(`UPDATE "Businesses" SET "PaymentSubaccountCode" = 'ACCT_installments' WHERE "Id" = $1`, [owner.businessId]);
    const portal = await api.call('POST', '/api/customer-portal/access', { body: { token: portalToken } });
    assert.equal(portal.status, 200, portal.text);
    const invoice = portal.body.invoices.find((item) => item.id === mine.invoiceId);
    assert.ok(invoice.installmentPlan, 'the portal carries the schedule');
    assert.equal(invoice.installmentPlan.installments.length, 4);
    assert.equal(Object.hasOwn(invoice.installmentPlan, 'createdByUserId'), false, 'nothing internal reaches the portal');
    const next = invoice.installmentPlan.next;
    assert.equal(next.sequence, 2);
    const result = await api.call('POST', '/api/customer-portal/invoices/pay', { body: { token: portalToken, invoiceId: mine.invoiceId, amount: next.payAmount } });
    assert.ok([200, 201].includes(result.status), result.text);
    assert.equal(started.at(-1).amountMinor, Math.round(next.payAmount * 100));
    assert.equal(await count(`SELECT count(*) AS n FROM "InvoiceInstallmentPlans" WHERE "BusinessId" = $1`, [other.businessId]), 0);
  });

  it('voiding an invoice ends its plan, and staff can cancel a plan with an audit entry', async () => {
    const fresh = await issuedInvoice(owner, 'inc');
    assert.equal((await makePlan(owner, fresh.invoiceId)).status, 201);
    const voided = await api.call('POST', `/api/invoices/${fresh.invoiceId}/void`, { token: owner.token, body: { reason: 'Issued by mistake' } });
    assert.equal(voided.status, 200, voided.text);
    const row = (await db.pool.query(`SELECT "Status", "CancelReason" FROM "InvoiceInstallmentPlans" WHERE "InvoiceId" = $1`, [fresh.invoiceId])).rows[0];
    assert.deepEqual(row, { Status: 'Cancelled', CancelReason: 'invoice_void' });
    assert.deepEqual((await api.call('GET', planUrl(fresh.invoiceId), { token: owner.token })).body, { plan: null });

    const cancelled = await api.call('DELETE', planUrl(mine.invoiceId), { token: owner.token, body: { reason: 'Customer will pay in one go' } });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.deepEqual((await api.call('GET', planUrl(mine.invoiceId), { token: owner.token })).body, { plan: null });
    assert.equal(await count(`SELECT count(*) AS n FROM "AuditLogs" WHERE "Action" = 'invoice.installment_plan_cancelled' AND "EntityId"::text = ANY($1::text[])`, [[fresh.invoiceId, mine.invoiceId]]), 2);
    const portal = await api.call('POST', '/api/customer-portal/access', { body: { token: portalToken } });
    assert.equal(portal.body.invoices.find((item) => item.id === mine.invoiceId).installmentPlan, null);
    assert.equal((await api.call('DELETE', planUrl(mine.invoiceId), { token: owner.token, body: {} })).status, 404, 'a cancelled plan cannot be cancelled again');
    assert.equal((await makePlan(owner, mine.invoiceId)).status, 201, 'a new plan can be made once the old one is cancelled');
  });
});
