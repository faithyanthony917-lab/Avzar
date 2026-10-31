process.env.NODE_ENV = 'test';
process.env.AVZAR_NOW = '2026-10-27T12:00:00.000Z';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPaymentAccount, handleInvoicePaymentWebhook, INVOICE_REFERENCE_PREFIX, listInvoicePaymentAttempts, portalContextForToken,
  PROVIDER_VERIFIER_ID, savePaymentAccount, startInvoicePayment,
} from '../src/auth/invoicePaymentService.js';

const BUSINESS = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000001';
const CUSTOMER = '00000000-0000-4000-8000-000000000010';
const OTHER_CUSTOMER = '00000000-0000-4000-8000-000000000011';
const INVOICE = '00000000-0000-4000-8000-000000000030';
const staff = { businessId: BUSINESS, userId: USER, allowed: null };
const portal = { businessId: BUSINESS, customerId: CUSTOMER };

// A pool that answers the exact statements the service sends. Anything it does not recognise (notification lookups) returns no rows.
function createPool(overrides = {}) {
  const state = {
    invoice: { Id: INVOICE, Number: 'INV-2026-00001', CustomerId: CUSTOMER, CurrencyCode: 'NGN', Status: 'Issued', Total: '100.00', AmountPaid: '0', AmountCredited: '0', LocationId: null },
    business: { Name: 'Sartoria', PaymentSubaccountCode: 'ACCT_test', TimeZoneId: 'Africa/Lagos' },
    email: 'ada@example.com', entitlement: 'true', attempts: [], payments: [], receipts: [], customerEvents: [], audits: [], calls: [], counter: 0, ...overrides,
  };
  const handle = async (sql, params = []) => {
    const text = String(sql).trim();
    state.calls.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 };
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.includes('FROM "Invoices" i')) return { rows: state.invoice ? [state.invoice] : [] };
    if (text.includes('finance.partial_payments')) return { rows: [{ Value: state.entitlement }] };
    if (text.includes('"IdempotencyKey" = $2') && text.includes('"InvoicePaymentAttempts"')) return { rows: state.attempts.filter((a) => a.IdempotencyKey === params[1]) };
    if (text.includes('"Status" = \'Pending\' AND "Amount" = $3')) {
      return { rows: state.attempts.filter((a) => a.Status === 'Pending' && a.Amount === params[2] && a.AuthorizationUrl && new Date(a.ExpiresAtUtc) > new Date()) };
    }
    if (text.includes('SELECT b."PaymentSubaccountCode", c."Email"')) return { rows: [{ PaymentSubaccountCode: state.business.PaymentSubaccountCode, Email: state.email }] };
    if (text.startsWith('INSERT INTO "InvoicePaymentAttempts"')) {
      state.attempts.push({ Id: params[0], BusinessId: params[1], InvoiceId: params[2], CustomerId: params[3], Reference: params[4], Amount: params[5], CurrencyCode: params[6],
        Status: 'Pending', Source: params[7], IdempotencyKey: params[8], RequestedByUserId: params[9], AuthorizationUrl: null, ExpiresAtUtc: params[10], PaymentId: null, CreatedAtUtc: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SET "Status" = \'Failed\'')) { state.attempts.find((a) => a.Id === params[1]).Status = 'Failed'; return { rows: [], rowCount: 1 }; }
    if (text.includes('SET "AuthorizationUrl" = $3')) { const a = state.attempts.find((x) => x.Id === params[1]); a.AuthorizationUrl = params[2]; return { rows: [a] }; }
    if (text.includes('FROM "InvoicePaymentAttempts" WHERE "Reference" = $1')) return { rows: state.attempts.filter((a) => a.Reference === params[0]) };
    if (text.includes('FROM "InvoicePaymentAttempts" WHERE "Id" = $1 FOR UPDATE')) return { rows: state.attempts.filter((a) => a.Id === params[0]) };
    if (text.includes('FROM "InvoicePaymentAttempts" WHERE "BusinessId" = $1 AND "InvoiceId" = $2')) return { rows: state.attempts };
    if (text.includes('SELECT "TimeZoneId" FROM "Businesses"')) return { rows: [{ TimeZoneId: state.business.TimeZoneId }] };
    if (text.startsWith('INSERT INTO "Payments"')) {
      const payment = { Id: params[0], Amount: params[1], BusinessId: params[2], CurrencyCode: params[3], CustomerId: params[4], IdempotencyKey: params[5], InvoiceId: params[6], ReceivedOn: params[7], Reference: params[8], Status: 'Verified', VerifiedByUserId: params[9] };
      state.payments.push(payment);
      return { rows: [payment] };
    }
    if (text.includes('INSERT INTO "DocumentCounters"')) { state.counter += 1; return { rows: [{ LastValue: state.counter }] }; }
    if (text.startsWith('INSERT INTO "CustomerEventOutbox"')) { state.customerEvents.push({ kind: params[2], subjectId: params[3], dedupeKey: params[4] }); return { rows: [] }; }
    if (text.startsWith('INSERT INTO "Receipts"')) { state.receipts.push({ amount: params[1], balanceAfter: params[2] }); return { rows: [] }; }
    if (text.includes('SET "Status" = \'Paid\'')) { const a = state.attempts.find((x) => x.Id === params[0]); a.Status = 'Paid'; a.PaymentId = params[1]; return { rows: [] }; }
    if (text.includes('SET "Status" = \'NeedsReview\'')) { const a = state.attempts.find((x) => x.Id === params[0]); a.Status = 'NeedsReview'; a.FailureReason = params[1]; return { rows: [] }; }
    if (text.startsWith('INSERT INTO "AuditLogs"')) { state.audits.push(params); return { rows: [] }; }
    if (text.includes('SELECT "PaymentSubaccountCode" FROM "Businesses"')) return { rows: [{ PaymentSubaccountCode: state.business.PaymentSubaccountCode }] };
    if (text.includes('SELECT "Name" FROM "Businesses"')) return { rows: [{ Name: state.business.Name }] };
    if (text.startsWith('UPDATE "Businesses" SET "PaymentSubaccountCode"')) { state.business.PaymentSubaccountCode = params[1]; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  return { state, query: handle, async connect() { return { query: handle, release() {} }; } };
}

function createProvider(overrides = {}) {
  const calls = { initialize: [], verify: [], createSubaccount: [] };
  return {
    calls,
    isConfigured: () => true,
    verifySignature: (_raw, signature) => signature === 'good',
    async initialize(args) { calls.initialize.push(args); return { authorizationUrl: `https://checkout.example/${args.reference}` }; },
    async verify(reference) { calls.verify.push(reference); return { status: 'success', reference, currency: 'NGN', amountMinor: 10000 }; },
    async createSubaccount(args) { calls.createSubaccount.push(args); return { subaccountCode: 'ACCT_new', accountName: 'ADA LOVELACE' }; },
    async listBanks() { return [{ name: 'Test Bank', code: '044' }]; },
    ...overrides,
  };
}
const body = (reference) => Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference } }));
const quiet = { error() {} };

describe('starting an online invoice payment', () => {
  it('passes the return address to the provider only when one is given', async () => {
    const withUrl = createProvider();
    await startInvoicePayment(createPool(), withUrl, staff, INVOICE, { callbackUrl: 'https://web.example/customer-portal?payment=complete' });
    assert.equal(withUrl.calls.initialize[0].callbackUrl, 'https://web.example/customer-portal?payment=complete');
    const without = createProvider();
    await startInvoicePayment(createPool(), without, staff, INVOICE, {});
    assert.equal('callbackUrl' in without.calls.initialize[0], false);
  });

  it('creates a pending attempt for the whole balance and asks the provider to split the payment to the business subaccount', async () => {
    const pool = createPool();
    const provider = createProvider();
    const { attempt, created } = await startInvoicePayment(pool, provider, staff, INVOICE, {});
    assert.equal(created, true);
    assert.equal(attempt.amount, 100);
    assert.equal(attempt.status, 'Pending');
    assert.match(attempt.authorizationUrl, /^https:\/\/checkout\.example\/avzar_inv_[0-9a-f]{24}$/);
    const sent = provider.calls.initialize[0];
    assert.equal(sent.amountMinor, 10000);
    assert.equal(sent.currency, 'NGN');
    assert.equal(sent.subaccount, 'ACCT_test');
    assert.equal(sent.email, 'ada@example.com');
    assert.ok(sent.reference.startsWith(INVOICE_REFERENCE_PREFIX));
    assert.deepEqual(Object.keys(sent.metadata).sort(), ['attemptId', 'invoiceNumber', 'kind'], 'no customer details are sent in metadata');
    assert.equal(pool.state.attempts[0].Source, 'Staff');
    assert.equal(pool.state.payments.length, 0, 'starting a payment never changes the balance');
  });

  it('returns the same open link for a repeated request instead of making another attempt', async () => {
    const pool = createPool();
    const provider = createProvider();
    const first = await startInvoicePayment(pool, provider, staff, INVOICE, {});
    const second = await startInvoicePayment(pool, provider, staff, INVOICE, {});
    assert.equal(second.created, false);
    assert.equal(second.attempt.id, first.attempt.id);
    assert.equal(pool.state.attempts.length, 1);
    assert.equal(provider.calls.initialize.length, 1);
  });

  it('an idempotency key returns its attempt, and a different amount under the same key is refused', async () => {
    const pool = createPool();
    const provider = createProvider();
    const first = await startInvoicePayment(pool, provider, staff, INVOICE, { idempotencyKey: 'k1' });
    const again = await startInvoicePayment(pool, provider, staff, INVOICE, { idempotencyKey: 'k1' });
    assert.equal(again.attempt.id, first.attempt.id);
    await assert.rejects(() => startInvoicePayment(pool, provider, staff, INVOICE, { idempotencyKey: 'k1', amount: 40 }), { code: 'idempotency_key_reused' });
  });

  it('a deposit needs the partial-payment plan feature; more than the balance is refused', async () => {
    const provider = createProvider();
    await assert.rejects(() => startInvoicePayment(createPool({ entitlement: 'false' }), provider, staff, INVOICE, { amount: 40 }), { code: 'feature_not_in_plan' });
    const ok = await startInvoicePayment(createPool(), provider, staff, INVOICE, { amount: 40 });
    assert.equal(ok.attempt.amount, 40);
    assert.equal(provider.calls.initialize[0].amountMinor, 4000);
    await assert.rejects(() => startInvoicePayment(createPool(), provider, staff, INVOICE, { amount: 100.01 }), { code: 'overpayment' });
    await assert.rejects(() => startInvoicePayment(createPool(), provider, staff, INVOICE, { amount: 0.001 }), { code: 'invalid_amount' });
    await assert.rejects(() => startInvoicePayment(createPool(), provider, staff, INVOICE, { amount: -5 }), { code: 'invalid_amount' });
  });

  it('only issued invoices with something owed can be paid', async () => {
    const provider = createProvider();
    await assert.rejects(() => startInvoicePayment(createPool({ invoice: { ...createPool().state.invoice, Status: 'Void' } }), provider, staff, INVOICE, {}), { code: 'invoice_not_payable' });
    await assert.rejects(() => startInvoicePayment(createPool({ invoice: { ...createPool().state.invoice, AmountPaid: '100.00' } }), provider, staff, INVOICE, {}), { code: 'nothing_owed' });
    await assert.rejects(() => startInvoicePayment(createPool({ invoice: null }), provider, staff, INVOICE, {}), { code: 'invoice_not_found' });
  });

  it('refuses when the business has no payout account or the customer has no email, and when the provider is not configured', async () => {
    const provider = createProvider();
    await assert.rejects(() => startInvoicePayment(createPool({ business: { Name: 'S', PaymentSubaccountCode: null, TimeZoneId: 'UTC' } }), provider, staff, INVOICE, {}), { code: 'online_payments_not_set_up' });
    await assert.rejects(() => startInvoicePayment(createPool({ email: null }), provider, staff, INVOICE, {}), { code: 'customer_email_required' });
    await assert.rejects(() => startInvoicePayment(createPool(), createProvider({ isConfigured: () => false }), staff, INVOICE, {}), { code: 'payments_unavailable' });
    assert.equal(provider.calls.initialize.length, 0);
  });

  it('a portal customer can pay their own invoice only; another customer\'s invoice looks like it does not exist', async () => {
    const provider = createProvider();
    const pool = createPool();
    const ok = await startInvoicePayment(pool, provider, portal, INVOICE, {});
    assert.equal(pool.state.attempts[0].Source, 'Portal');
    assert.equal(ok.attempt.invoiceId, INVOICE);
    await assert.rejects(() => startInvoicePayment(createPool(), provider, { businessId: BUSINESS, customerId: OTHER_CUSTOMER }, INVOICE, {}), { code: 'invoice_not_found' });
  });

  it('closes the attempt as Failed when the provider call fails, and leaves no open link', async () => {
    const pool = createPool();
    const provider = createProvider({ async initialize() { throw new Error('provider down'); } });
    await assert.rejects(() => startInvoicePayment(pool, provider, staff, INVOICE, {}), /provider down/);
    assert.equal(pool.state.attempts[0].Status, 'Failed');
    assert.equal(pool.state.attempts[0].AuthorizationUrl, null);
  });

  it('a stale attempt that is Failed is not shown with a link', async () => {
    const pool = createPool();
    const provider = createProvider({ async initialize() { throw new Error('x'); } });
    await assert.rejects(() => startInvoicePayment(pool, provider, staff, INVOICE, {}));
    const list = await listInvoicePaymentAttempts(pool, { businessId: BUSINESS, userId: USER }, INVOICE, null);
    assert.equal(list.items[0].authorizationUrl, null);
  });
});

describe('the payment provider webhook', () => {
  async function started(poolOptions) {
    const pool = createPool(poolOptions);
    const provider = createProvider();
    const { attempt } = await startInvoicePayment(pool, provider, staff, INVOICE, {});
    return { pool, provider, reference: pool.state.attempts.find((a) => a.Id === attempt.id).Reference };
  }

  it('rejects a bad signature and ignores events and references that are not for invoices', async () => {
    const { pool, provider, reference } = await started();
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(reference), 'bad', quiet), 401);
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, Buffer.from(JSON.stringify({ event: 'transfer.success', data: { reference } })), 'good', quiet), 200);
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body('avzar_rtw_123'), 'good', quiet), 200);
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, Buffer.from('not json'), 'good', quiet), 400);
    assert.equal(pool.state.payments.length, 0);
    assert.equal(provider.calls.verify.length, 0);
  });

  it('an unmatched reference is logged and answered 404 so the provider retries', async () => {
    const { pool, provider } = await started();
    const logged = [];
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body('avzar_inv_unknown'), 'good', { error: (line) => logged.push(line) }), 404);
    assert.match(logged[0], /invoice_payment_webhook_unmatched_reference/);
  });

  it('applies nothing when the provider says a different amount or currency, or the charge did not succeed', async () => {
    const { pool, reference } = await started();
    const cases = [
      { amountMinor: 9999 }, { currency: 'USD' }, { status: 'failed' }, { reference: 'avzar_inv_other' },
    ];
    for (const change of cases) {
      const provider = createProvider({ async verify(ref) { return { status: 'success', reference: ref, currency: 'NGN', amountMinor: 10000, ...change }; } });
      assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(reference), 'good', quiet), 400, JSON.stringify(change));
    }
    assert.equal(pool.state.payments.length, 0);
    assert.equal(pool.state.attempts[0].Status, 'Pending');
  });

  it('a confirmed payment becomes one verified card payment with a receipt, and a replay changes nothing', async () => {
    const { pool, provider, reference } = await started();
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(reference), 'good', quiet), 200);
    assert.equal(pool.state.payments.length, 1);
    const payment = pool.state.payments[0];
    assert.equal(payment.Amount, 100);
    assert.equal(payment.Status, 'Verified');
    assert.equal(payment.VerifiedByUserId, PROVIDER_VERIFIER_ID);
    assert.equal(payment.Reference, reference);
    assert.equal(pool.state.receipts.length, 1);
    assert.equal(pool.state.receipts[0].balanceAfter, 0);
    assert.equal(pool.state.customerEvents.length, 1, 'an online payment queues the customer\'s receipt message');
    assert.equal(pool.state.customerEvents[0].kind, 'payment.receipt');
    assert.equal(pool.state.customerEvents[0].dedupeKey, `payment.receipt:${pool.state.customerEvents[0].subjectId}`);
    assert.equal(pool.state.attempts[0].Status, 'Paid');
    assert.equal(pool.state.attempts[0].PaymentId, payment.Id);
    assert.ok(pool.state.audits.some((params) => params[1] === 'payment.recorded_online'));
    const verifyCallsBefore = provider.calls.verify.length;
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(reference), 'good', quiet), 200);
    assert.equal(pool.state.payments.length, 1, 'replay records nothing');
    assert.equal(provider.calls.verify.length, verifyCallsBefore, 'a paid attempt is not re-verified');
  });

  it('a payment for an invoice that is no longer payable is held for review, never recorded', async () => {
    const { pool, provider, reference } = await started();
    pool.state.invoice = { ...pool.state.invoice, Status: 'Void' };
    const logged = [];
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(reference), 'good', { error: (line) => logged.push(line) }), 200);
    assert.equal(pool.state.payments.length, 0);
    assert.equal(pool.state.attempts[0].Status, 'NeedsReview');
    assert.equal(pool.state.attempts[0].FailureReason, 'invoice_not_payable');
    assert.match(logged[0], /invoice_payment_needs_review/);
  });

  it('a payment that would overpay because the balance changed meanwhile is held for review', async () => {
    const { pool, provider, reference } = await started();
    pool.state.invoice = { ...pool.state.invoice, AmountPaid: '60.00' };
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(reference), 'good', quiet), 200);
    assert.equal(pool.state.payments.length, 0);
    assert.equal(pool.state.attempts[0].FailureReason, 'overpayment');
  });

  it('a deposit leaves the rest owed on the receipt', async () => {
    const pool = createPool();
    const provider = createProvider({ async verify(ref) { return { status: 'success', reference: ref, currency: 'NGN', amountMinor: 4000 }; } });
    await startInvoicePayment(pool, provider, staff, INVOICE, { amount: 40 });
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(pool.state.attempts[0].Reference), 'good', quiet), 200);
    assert.equal(pool.state.receipts[0].balanceAfter, 60);
  });

  it('answers 502 when the provider cannot confirm, so the webhook is retried', async () => {
    const { pool, reference } = await started();
    const provider = createProvider({ async verify() { throw new Error('timeout'); } });
    assert.equal(await handleInvoicePaymentWebhook(pool, provider, body(reference), 'good', quiet), 502);
    assert.equal(pool.state.payments.length, 0);
  });
});

describe('the business payout account', () => {
  it('reports whether one is set up and never returns the code', async () => {
    assert.deepEqual(await getPaymentAccount(createPool(), { businessId: BUSINESS }), { configured: true });
    assert.deepEqual(await getPaymentAccount(createPool({ business: { Name: 'S', PaymentSubaccountCode: null, TimeZoneId: 'UTC' } }), { businessId: BUSINESS }), { configured: false });
  });

  it('sends the account number to the provider once, stores only the provider code, and audits the bank code only', async () => {
    const pool = createPool({ business: { Name: 'Sartoria', PaymentSubaccountCode: null, TimeZoneId: 'UTC' } });
    const provider = createProvider();
    const result = await savePaymentAccount(pool, provider, { businessId: BUSINESS, userId: USER }, { bankCode: '044', accountNumber: '0123456789' });
    assert.deepEqual(result, { configured: true, accountName: 'ADA LOVELACE' });
    assert.deepEqual(provider.calls.createSubaccount[0], { businessName: 'Sartoria', bankCode: '044', accountNumber: '0123456789' });
    assert.equal(pool.state.business.PaymentSubaccountCode, 'ACCT_new');
    const everything = JSON.stringify(pool.state.audits) + JSON.stringify(pool.state.calls.filter((c) => !c.text.includes('PaymentSubaccountCode')).map((c) => c.params));
    assert.ok(!everything.includes('0123456789'), 'the account number is never stored or logged');
  });

  it('validates the bank code and the 10-digit account number before calling the provider', async () => {
    const provider = createProvider();
    const pool = createPool();
    await assert.rejects(() => savePaymentAccount(pool, provider, { businessId: BUSINESS }, { bankCode: 'x', accountNumber: '0123456789' }), { code: 'invalid_bank_code' });
    await assert.rejects(() => savePaymentAccount(pool, provider, { businessId: BUSINESS }, { bankCode: '044', accountNumber: '123' }), { code: 'invalid_account_number' });
    assert.equal(provider.calls.createSubaccount.length, 0);
  });
});

describe('portal tokens', () => {
  it('a missing, short or unknown token gets the same not-found answer', async () => {
    const pool = createPool();
    for (const token of [undefined, '', 'short', 'x'.repeat(40)]) {
      await assert.rejects(() => portalContextForToken(pool, token), { code: 'portal_link_unavailable' });
    }
  });
});
