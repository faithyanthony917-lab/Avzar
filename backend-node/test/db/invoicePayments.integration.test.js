// Step 15a: online payment of an invoice over HTTP on real PostgreSQL, through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: the business payout account route; starting a payment as staff and as a portal customer; that another business gets 404 on every
// route; that the provider webhook finds the business from the provider reference alone (key-matched lookup policy, no business context),
// records one verified Card payment plus a receipt, ignores a replay, and refuses a reference it does not know; and that the attempts table
// shows nothing without a business context. A fake provider stands in for Paystack (unverified with live credentials).
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const PROVIDER_VERIFIER_ID = '00000000-0000-4000-8000-00000000fa11';

describe('online invoice payment on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let viewer; let invoiceId; let customerId; let portalToken; let otherInvoiceId;
  const started = [];
  const provider = {
    isConfigured: () => true,
    verifySignature: (_raw, signature) => signature === 'good',
    async initialize(args) { started.push(args); return { authorizationUrl: `https://checkout.example/${args.reference}` }; },
    async verify(reference) { const sent = started.find((s) => s.reference === reference); return { status: 'success', reference, currency: sent.currency, amountMinor: sent.amountMinor }; },
    async createSubaccount() { return { subaccountCode: 'ACCT_integration', accountName: 'TEST ACCOUNT' }; },
    async listBanks() { return [{ name: 'Test Bank', code: '044' }]; },
  };
  const count = async (sql, params) => Number((await db.pool.query(sql, params)).rows[0].n);
  const pay = (who, id, body = {}) => api.call('POST', `/api/invoices/${id}/online-payment`, { token: who.token, body });
  const hook = (reference, signature = 'good') => api.call('POST', '/api/invoice-payments/webhook', {
    body: { event: 'charge.success', data: { reference } }, headers: { 'x-paystack-signature': signature },
  });
  const issuedInvoice = async (who, locationId, label) => {
    const order = await confirmedOrder(api, db, who, locationId, label);
    const draft = await api.call('POST', `/api/invoices/from-order/${order.orderId}`, { token: who.token, body: { mode: 'Full' } });
    assert.equal(draft.status, 201, draft.text);
    assert.equal((await api.call('POST', `/api/invoices/${draft.body.id}/issue`, { token: who.token })).status, 200);
    return { invoiceId: draft.body.id, customerId: order.customerId };
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_inv_pay');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool, {}, { billingProvider: provider });
    owner = await signUp(api, 'ip-owner');
    other = await signUp(api, 'ip-other');
    viewer = await addStaff(api, db, owner, 'ip-viewer', ['payments.view', 'locations.all']);
    const mine = await issuedInvoice(owner, await firstLocationId(db, owner.businessId), 'ipa');
    invoiceId = mine.invoiceId; customerId = mine.customerId;
    const portalEmail = (await db.pool.query(`SELECT "TextBody" FROM "EmailOutbox" WHERE "BusinessId" = $1 AND "TemplateKey" = 'quotation_sent' ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [owner.businessId])).rows[0];
    portalToken = /customer-portal#([A-Za-z0-9_-]+)/.exec(portalEmail.TextBody)?.[1];
    assert.ok(portalToken, 'the quotation email carries the portal token');
    otherInvoiceId = (await issuedInvoice(other, await firstLocationId(db, other.businessId), 'ipb')).invoiceId;
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('refuses to start a payment until the business has a payout account', async () => {
    const result = await pay(owner, invoiceId);
    assert.equal(result.status, 409, result.text);
    assert.equal(result.body.code ?? result.body.error?.code, 'online_payments_not_set_up');
    assert.equal(started.length, 0);
    const portal = await api.call('POST', '/api/customer-portal/access', { body: { token: portalToken } });
    assert.equal(portal.status, 200, portal.text);
    assert.equal(portal.body.onlinePaymentsEnabled, false, 'the portal does not offer online payment before a payout account exists');
  });

  it('only a person with business.settings sets the payout account; only the provider code is stored', async () => {
    assert.equal((await api.call('PUT', '/api/business/payment-account', { token: viewer.token, body: { bankCode: '044', accountNumber: '0123456789' } })).status, 403);
    assert.equal((await api.call('GET', '/api/business/payment-account', { token: owner.token })).body.configured, false);
    const saved = await api.call('PUT', '/api/business/payment-account', { token: owner.token, body: { bankCode: '044', accountNumber: '0123456789' } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await api.call('GET', '/api/business/payment-account', { token: owner.token })).body.configured, true);
    const stored = await db.pool.query(`SELECT "PaymentSubaccountCode" FROM "Businesses" WHERE "Id" = $1`, [owner.businessId]);
    assert.equal(stored.rows[0].PaymentSubaccountCode, 'ACCT_integration');
    assert.equal((await api.call('GET', '/api/business/payment-account/banks', { token: owner.token })).body.items[0].code, '044');
    const portal = await api.call('POST', '/api/customer-portal/access', { body: { token: portalToken } });
    assert.equal(portal.body.onlinePaymentsEnabled, true, 'the portal offers online payment once the payout account is saved');
    assert.equal(await count(`SELECT count(*) AS n FROM "AuditLogs" WHERE "Action" = 'business.payment_account_saved' AND "DetailsJson"::text LIKE '%0123456789%'`), 0, 'the account number is not in the audit log');
  });

  let reference; let startedAmount;
  it('staff with payments.record start a payment: one pending attempt, split to the subaccount; a viewer cannot', async () => {
    assert.equal((await pay(viewer, invoiceId)).status, 403);
    const result = await pay(owner, invoiceId);
    assert.equal(result.status, 201, result.text);
    assert.equal(result.body.attempt.status, 'Pending');
    assert.match(result.body.attempt.authorizationUrl, /^https:\/\/checkout\.example\/avzar_inv_/);
    assert.equal(started.length, 1);
    assert.equal(started[0].subaccount, 'ACCT_integration');
    reference = started[0].reference; startedAmount = result.body.attempt.amount;
    assert.equal(await count(`SELECT count(*) AS n FROM "Payments" WHERE "InvoiceId" = $1`, [invoiceId]), 0, 'no payment before the provider confirms');
    const again = await pay(owner, invoiceId);
    assert.equal(again.status, 200);
    assert.equal(again.body.attempt.id, result.body.attempt.id, 'the open link is reused');
    const listed = await api.call('GET', `/api/invoices/${invoiceId}/online-payments`, { token: viewer.token });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.items.length, 1);
  });

  it('another business gets 404 on every invoice route, and cannot see or start anything', async () => {
    assert.equal((await pay(other, invoiceId)).status, 404);
    assert.equal((await api.call('GET', `/api/invoices/${invoiceId}/online-payments`, { token: other.token })).status, 404);
    assert.equal((await pay(owner, otherInvoiceId)).status, 404);
    assert.equal(await count(`SELECT count(*) AS n FROM "InvoicePaymentAttempts" WHERE "BusinessId" = $1`, [other.businessId]), 0);
  });

  it('the portal customer can start a payment for their own invoice; a bad token and another business\'s invoice are not found', async () => {
    const ok = await api.call('POST', '/api/customer-portal/invoices/pay', { body: { token: portalToken, invoiceId } });
    assert.ok([200, 201].includes(ok.status), ok.text);
    assert.equal(ok.body.attempt.invoiceId, invoiceId);
    assert.equal((await api.call('POST', '/api/customer-portal/invoices/pay', { body: { token: 'x'.repeat(40), invoiceId } })).status, 404);
    assert.equal((await api.call('POST', '/api/customer-portal/invoices/pay', { body: { token: portalToken, invoiceId: otherInvoiceId } })).status, 404);
  });

  it('with no business context the restricted role sees no attempts at all', async () => {
    assert.equal(Number((await role.pool.query('SELECT count(*)::int AS n FROM "InvoicePaymentAttempts"')).rows[0].n), 0);
  });

  it('the webhook rejects a bad signature and a reference it does not know', async () => {
    assert.equal((await hook(reference, 'bad')).status, 401);
    assert.equal((await hook('avzar_inv_unknownreference')).status, 404);
    assert.equal(await count(`SELECT count(*) AS n FROM "Payments" WHERE "InvoiceId" = $1`, [invoiceId]), 0);
  });

  it('the webhook finds the business from the reference alone and records one verified card payment with a receipt', async () => {
    const result = await hook(reference);
    assert.equal(result.status, 200, result.text);
    const payments = (await db.pool.query(`SELECT "Amount", "Method", "Status", "Reference", "VerifiedByUserId" FROM "Payments" WHERE "InvoiceId" = $1`, [invoiceId])).rows;
    assert.equal(payments.length, 1);
    assert.equal(Number(payments[0].Amount), startedAmount);
    assert.equal(payments[0].Method, 'Card');
    assert.equal(payments[0].Status, 'Verified');
    assert.equal(payments[0].Reference, reference);
    assert.equal(payments[0].VerifiedByUserId, PROVIDER_VERIFIER_ID);
    assert.equal(await count(`SELECT count(*) AS n FROM "Receipts" r JOIN "Payments" p ON p."Id" = r."PaymentId" WHERE p."InvoiceId" = $1`, [invoiceId]), 1);
    const attempt = (await db.pool.query(`SELECT "Status", "PaymentId" FROM "InvoicePaymentAttempts" WHERE "Reference" = $1`, [reference])).rows[0];
    assert.equal(attempt.Status, 'Paid');
    assert.ok(attempt.PaymentId);
    assert.equal(await count(`SELECT count(*) AS n FROM "AuditLogs" WHERE "Action" = 'payment.recorded_online' AND "BusinessId" = $1`, [owner.businessId]), 1);
  });

  it('a replay changes nothing, and the paid invoice cannot be paid online again', async () => {
    assert.equal((await hook(reference)).status, 200);
    assert.equal(await count(`SELECT count(*) AS n FROM "Payments" WHERE "InvoiceId" = $1`, [invoiceId]), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM "Receipts" r JOIN "Payments" p ON p."Id" = r."PaymentId" WHERE p."InvoiceId" = $1`, [invoiceId]), 1);
    const again = await pay(owner, invoiceId);
    assert.equal(again.status, 409, again.text);
    assert.ok(['nothing_owed', 'invoice_not_payable'].includes(again.body.code ?? again.body.error?.code));
  });

  it('the other business\'s data is untouched by every step above', async () => {
    assert.equal(await count(`SELECT count(*) AS n FROM "Payments" WHERE "BusinessId" = $1`, [other.businessId]), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM "InvoicePaymentAttempts" WHERE "BusinessId" = $1`, [other.businessId]), 0);
    void customerId;
  });
});
