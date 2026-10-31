// Step 15c: the payment reconciliation report over HTTP on real PostgreSQL, through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: it needs reports.view and payments.view; collected money counts only Verified payments in the range (online and staff-recorded
// kept apart); each finding appears (money to review, unpaid links past expiry, payments nobody verified for 3 days, payments on a voided
// invoice, an online payment reversed in Avzar); open invoices and overdue installments are read as of today; findings that are open items
// do not depend on the date range; another business never sees or counts a row of this one; a location-limited user sees none of an
// order's rows outside their locations; and the report changes nothing. A fake provider is not needed: attempts are written directly, the
// way the webhook leaves them. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, paidInvoice, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('reconciliation report on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let viewer; let noPayments; let noReports; let limited;
  let invoiceA; let invoiceB; let invoiceC; let invoiceD; let invoiceE; let otherInvoice;
  const refs = { review: `rv-${randomBytes(4).toString('hex')}`, stale: `st-${randomBytes(4).toString('hex')}`, reversed: `rf-${randomBytes(4).toString('hex')}`, other: `ot-${randomBytes(4).toString('hex')}` };
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const report = (who, query = `from=${yesterday}&to=${today}`) => api.call('GET', `/api/reports/reconciliation?${query}`, { token: who.token });
  const count = async (sql, params) => Number((await db.pool.query(sql, params)).rows[0].n);

  const issued = async (who, label) => {
    const order = await confirmedOrder(api, db, who, await firstLocationId(db, who.businessId), label);
    const draft = await api.call('POST', `/api/invoices/from-order/${order.orderId}`, { token: who.token, body: { mode: 'Full' } });
    assert.equal(draft.status, 201, draft.text);
    assert.equal((await api.call('POST', `/api/invoices/${draft.body.id}/issue`, { token: who.token })).status, 200);
    return { invoiceId: draft.body.id, total: Number(draft.body.total), customerId: order.customerId };
  };
  const paid = async (who, label) => {
    const order = await confirmedOrder(api, db, who, await firstLocationId(db, who.businessId), label);
    const result = await paidInvoice(api, who, order.orderId);
    return { invoiceId: result.invoiceId, total: Number(result.total), paymentId: result.paymentId, customerId: order.customerId };
  };
  const attempt = (who, inv, { status, reference, amount = inv.total, paymentId = null, reason = null, expires = "now() + interval '1 day'" }) => db.pool.query(`
    INSERT INTO "InvoicePaymentAttempts" ("Id", "BusinessId", "InvoiceId", "CustomerId", "Reference", "Amount", "CurrencyCode", "Status", "Source",
      "ExpiresAtUtc", "PaymentId", "FailureReason", "UpdatedAtUtc")
    VALUES ($1, $2, $3, $4, $5, $6, 'NGN', $7, 'Staff', ${expires}, $8, $9, now())`,
  [randomUUID(), who.businessId, inv.invoiceId, inv.customerId, reference, amount, status, paymentId, reason]);

  before(async () => {
    db = await createTempDatabase(url, 'avzar_recon');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'rc-owner');
    other = await signUp(api, 'rc-other');
    await upgradePlan(db, owner.businessId, 'starter');
    await upgradePlan(db, other.businessId, 'starter');
    await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
      VALUES ($1,$2,now(),'users.max','test fixture: more staff than the plan allows','unlimited')`, [randomUUID(), owner.businessId]);
    viewer = await addStaff(api, db, owner, 'rc-viewer', ['reports.view', 'payments.view', 'locations.all']);
    noPayments = await addStaff(api, db, owner, 'rc-nopay', ['reports.view', 'locations.all']);
    noReports = await addStaff(api, db, owner, 'rc-noreport', ['payments.view', 'locations.all']);
    limited = await addStaff(api, db, owner, 'rc-limited', ['reports.view', 'payments.view']);

    invoiceA = await issued(owner, 'rca');           // open, unpaid: gets the NeedsReview attempt and the installment plan
    invoiceB = await paid(owner, 'rcb');             // collected by staff
    invoiceC = await paid(owner, 'rcc');             // paid online, then reversed in Avzar
    invoiceD = await paid(owner, 'rcd');             // paid, then the invoice is voided
    invoiceE = await issued(owner, 'rce');           // a payment recorded and never verified
    otherInvoice = await issued(other, 'rco');

    await attempt(owner, invoiceA, { status: 'NeedsReview', reference: refs.review, reason: 'overpayment' });
    await attempt(owner, invoiceE, { status: 'Pending', reference: refs.stale, expires: "now() - interval '1 hour'" });
    await attempt(owner, invoiceC, { status: 'Paid', reference: refs.reversed, paymentId: invoiceC.paymentId });
    assert.equal((await api.call('POST', `/api/payments/${invoiceC.paymentId}/reverse`, { token: owner.token, body: { reason: 'Refunded to the customer in Paystack' } })).status, 200);
    await db.pool.query(`UPDATE "Invoices" SET "Status" = 'Void', "VoidReason" = 'test', "VoidedAtUtc" = now() WHERE "Id" = $1`, [invoiceD.invoiceId]);
    const pending = await api.call('POST', `/api/invoices/${invoiceE.invoiceId}/payments`, { token: owner.token, body: { amount: 1000, method: 'Cash' }, headers: { 'idempotency-key': `rc-${randomBytes(6).toString('hex')}` } });
    assert.equal(pending.status, 201, pending.text);
    await db.pool.query(`UPDATE "Payments" SET "CreatedAtUtc" = now() - interval '5 days' WHERE "Id" = $1`, [pending.body.id]);
    await attempt(other, otherInvoice, { status: 'NeedsReview', reference: refs.other, reason: 'invoice_not_payable' });
    const plan = await api.call('POST', `/api/invoices/${invoiceA.invoiceId}/installment-plan`, { token: owner.token, body: { parts: 4, firstDueDate: '2099-01-01', interval: 'monthly' } });
    assert.equal(plan.status, 201, plan.text);
    await db.pool.query(`UPDATE "InvoiceInstallments" SET "DueDate" = current_date - 5 WHERE "BusinessId" = $1`, [owner.businessId]);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('needs reports.view and payments.view, and a bad range is a 400', async () => {
    assert.equal((await report(viewer)).status, 200);
    assert.equal((await report(noPayments)).status, 403);
    assert.equal((await report(noReports)).status, 403);
    const tooLong = await report(owner, 'from=2025-01-01&to=2026-10-27');
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.code ?? tooLong.body.error?.code, 'invalid_report_range');
  });

  it('counts only Verified payments of the range as collected, staff-recorded apart from online', async () => {
    const result = await report(owner);
    assert.equal(result.status, 200, result.text);
    const { collected } = result.body;
    assert.equal(collected.count, 2, 'invoice B and the (now voided) invoice D; the reversed and the unverified payments do not count');
    assert.equal(collected.amount, invoiceB.total + invoiceD.total);
    assert.equal(collected.staffRecorded.count, 2);
    assert.equal(collected.online.count, 0);
    assert.deepEqual(collected.byMethod.map((row) => row.method), ['BankTransfer']);
  });

  it('lists money to review, expired unpaid links, old unverified payments, payments on a voided invoice and a reversed online payment', async () => {
    const { needsAttention, attentionCount } = (await report(owner)).body;
    assert.deepEqual(needsAttention.needsReviewPayments.items.map((i) => [i.reference, i.reason, i.invoiceNumber != null]), [[refs.review, 'overpayment', true]]);
    assert.equal(needsAttention.needsReviewPayments.amount, invoiceA.total);
    assert.deepEqual(needsAttention.staleLinks.items.map((i) => i.reference), [refs.stale]);
    assert.equal(needsAttention.pendingVerification.count, 1);
    assert.equal(needsAttention.pendingVerification.items[0].amount, 1000);
    assert.equal(needsAttention.pendingVerification.thresholdDays, 3);
    assert.equal(needsAttention.paymentsOnVoidedInvoices.count, 1);
    assert.equal(needsAttention.paymentsOnVoidedInvoices.amount, invoiceD.total);
    assert.deepEqual(needsAttention.onlineMismatches.items.map((i) => [i.reference, i.kind, i.paymentStatus]), [[refs.reversed, 'reversed', 'Reversed']]);
    assert.equal(attentionCount, 5);
  });

  it('reads open invoices and overdue installments as of today', async () => {
    const { invoices } = (await report(owner)).body;
    assert.equal(invoices.openCount, 3, 'A (unpaid), C (its payment was reversed) and E (its payment is not verified); B is paid and D is void');
    assert.equal(invoices.openBalance, invoiceA.total + invoiceC.total + invoiceE.total);
    assert.equal(invoices.installmentsOverdue.plans, 1);
    assert.equal(invoices.installmentsOverdue.installments, 4);
    assert.equal(invoices.installmentsOverdue.amount, invoiceA.total);
    assert.equal(invoices.installmentsOverdue.items[0].invoiceId, invoiceA.invoiceId);
  });

  it('open items do not depend on the range; collected money and dated findings do', async () => {
    const old = (await report(owner, 'from=2020-01-01&to=2020-01-31')).body;
    assert.equal(old.collected.count, 0);
    assert.equal(old.needsAttention.staleLinks.count, 0);
    assert.equal(old.needsAttention.paymentsOnVoidedInvoices.count, 0);
    assert.equal(old.needsAttention.onlineMismatches.count, 0, 'the reversal is recent, so it is outside an old range');
    assert.equal(old.needsAttention.needsReviewPayments.count, 1);
    assert.equal(old.needsAttention.pendingVerification.count, 1);
  });

  it('another business sees only its own rows, and never counts this business\'s', async () => {
    const theirs = (await report(other)).body;
    assert.deepEqual(theirs.needsAttention.needsReviewPayments.items.map((i) => i.reference), [refs.other]);
    assert.equal(theirs.collected.count, 0);
    assert.equal(theirs.needsAttention.staleLinks.count, 0);
    assert.equal(theirs.invoices.openCount, 1);
    const mine = JSON.stringify((await report(owner)).body);
    assert.ok(!mine.includes(refs.other), 'a reference of another business never appears');
    assert.equal(Number((await role.pool.query('SELECT count(*)::int AS n FROM "InvoicePaymentAttempts"')).rows[0].n), 0, 'with no business context the restricted role sees no attempt');
  });

  it('a location-limited user sees nothing outside their locations', async () => {
    const result = await report(limited);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual([result.body.attentionCount, result.body.collected.count, result.body.invoices.openCount, result.body.invoices.installmentsOverdue.plans], [0, 0, 0, 0]);
  });

  it('changes nothing', async () => {
    const tables = ['Payments', 'InvoicePaymentAttempts', 'Invoices', 'InvoiceInstallments', 'AuditLogs', 'Notifications'];
    const read = async () => Promise.all(tables.map((t) => count(`SELECT count(*) AS n FROM "${t}"`)));
    const before = await read();
    await report(owner); await report(other); await report(owner, 'from=2020-01-01&to=2020-01-31');
    assert.deepEqual(await read(), before);
  });
});
