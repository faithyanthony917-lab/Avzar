process.env.NODE_ENV = 'test';
process.env.AVZAR_NOW = '2026-10-17T12:00:00.000Z';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPayment,
  getReceipt,
  getReceiptForPayment,
  listPayments,
  recordPayment,
  rejectPayment,
  reversePayment,
  verifyPayment,
} from '../src/auth/paymentService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const invoiceId = '00000000-0000-4000-8000-000000000030';
const paymentId = '00000000-0000-4000-8000-000000000040';
const receiptId = '00000000-0000-4000-8000-000000000050';
const locationId = '00000000-0000-4000-8000-000000000060';
const user = { businessId, userId, isOwner: true, permissions: ['payments.verify'] };
const empty = { rows: [] };

function createPool(overrides = {}) {
  const state = {
    invoice: {
      Id: invoiceId, Number: 'INV-2026-00001', CustomerId: '00000000-0000-4000-8000-000000000010',
      CurrencyCode: 'USD', Status: 'Issued', Total: '100.00', AmountPaid: '0', AmountCredited: '0',
      OrderId: '00000000-0000-4000-8000-000000000070', OrderLocationId: locationId,
    },
    payments: [],
    receipts: [], customerEvents: [],
    audit: [],
    notifications: [],
    entitlement: 'true',
    timezone: 'UTC',
    counter: 0,
    ...overrides,
  };

  async function query(sql, values = []) {
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return empty;
    if (sql.includes('pg_advisory_xact_lock')) return empty;
    if (sql.includes('FROM "Businesses"')) return { rows: [{ TimeZoneId: state.timezone }] };
     if (sql.includes('FROM "Memberships" m') && sql.includes('NotificationPreferences')) return { rows: [{
       Id: '00000000-0000-4000-8000-000000000099', DisplayName: 'Finance manager', Email: null,
       TimeZoneId: 'UTC', QuietHoursEnabled: false, InAppEnabled: true, EmailEnabled: false, PushEnabled: false,
     }] };
     if (sql.includes('INSERT INTO "NotificationOutbox"')) return { rows: [{
       Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
       Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
       InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
       EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
       Status: 'Pending', CreatedAtUtc: values[17],
     }], rowCount: 1 };
     if (sql.includes('INSERT INTO "Notifications"')) {
       state.notifications.push({ recipient: values[2], category: values[3], eventType: values[4], targetId: values[8] });
       return { rows: [], rowCount: 1 };
     }
     if (sql.includes('UPDATE "NotificationOutbox"')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: state.entitlement }] };
    if (sql.includes('FROM "Invoices" i')) {
      const invoice = state.invoice;
      if (!invoice || invoice.Id !== values[1] || invoice.BusinessId && invoice.BusinessId !== values[0]) return empty;
      if (values[2] && (!invoice.OrderId || !values[2].includes(invoice.OrderLocationId))) return empty;
      return { rows: [{ ...invoice }] };
    }
    if (sql.includes('SELECT p."Id", p."InvoiceId", p."Amount"')) {
      const match = state.payments.find((payment) => payment.IdempotencyKey === values[1]);
      return { rows: match ? [{ Id: match.Id, InvoiceId: match.InvoiceId, Amount: match.Amount, Version: String(match.Version) }] : [] };
    }
    if (sql.includes('count(*)::int AS "TotalCount"') && sql.includes('FROM "Payments" p')) {
      return { rows: [{ TotalCount: state.payments.length }] };
    }
    if (sql.includes('FROM "Payments" p') && sql.includes('JOIN "Invoices" i') && sql.includes('ORDER BY p."ReceivedOn"')) {
      return { rows: state.payments.map((payment) => {
        const receipt = state.receipts.find((row) => row.PaymentId === payment.Id);
        return { ...payment, InvoiceNumber: state.invoice.Number, ReceiptId: receipt?.Id ?? null,
          ReceiptNumber: receipt?.Number ?? null, Version: String(payment.Version) };
      }) };
    }
    if (sql.includes('FROM "Payments" p') && sql.includes('JOIN "Invoices" i') && sql.includes('p."Id" =')) {
      const payment = state.payments.find((row) => row.Id === values.at(-1));
      if (!payment || payment.BusinessId !== values[0]) return empty;
      if (Array.isArray(values[1]) && (!state.invoice.OrderId || !values[1].includes(state.invoice.OrderLocationId))) return empty;
      const receipt = state.receipts.find((row) => row.PaymentId === payment.Id);
      return { rows: [{ ...payment, InvoiceNumber: state.invoice.Number, ReceiptId: receipt?.Id ?? null,
        ReceiptNumber: receipt?.Number ?? null, Version: String(payment.Version) }] };
    }
    if (sql.includes('INSERT INTO "Payments"')) {
      const payment = {
        Id: values[0], Amount: String(values[1]), BusinessId: values[2], CurrencyCode: values[3],
        CustomerId: values[4], IdempotencyKey: values[5], InvoiceId: values[6], Method: values[7],
        Notes: values[8], ReceivedOn: values[9], RecordedByUserId: values[10], Reference: values[11],
        Status: values[12], VerifiedAtUtc: values[13], VerifiedByUserId: values[14],
        StatusReason: null, CreatedAtUtc: '2026-10-17T12:00:00.000Z', Version: 1,
      };
      state.payments.push(payment);
      return { rows: [{ ...payment, Version: '1' }] };
    }
    if (sql.includes("UPDATE \"Payments\" SET \"Status\" = 'Verified'")) {
      const payment = state.payments.find((row) => row.Id === values[3]);
      if (!payment || payment.Version !== Number(values[4]) || payment.Status !== 'Pending') return empty;
      payment.Status = 'Verified';
      payment.VerifiedByUserId = values[0];
      payment.VerifiedAtUtc = values[1];
      payment.Version += 1;
      return { rows: [{ ...payment }] };
    }
    if (sql.includes("UPDATE \"Payments\" SET \"Status\" = 'Rejected'")) {
      const payment = state.payments.find((row) => row.Id === values[2]);
      if (!payment || payment.Version !== Number(values[3]) || payment.Status !== 'Pending') return empty;
      payment.Status = 'Rejected';
      payment.StatusReason = values[0];
      payment.Version += 1;
      return { rows: [{ Id: payment.Id }] };
    }
    if (sql.includes("UPDATE \"Payments\" SET \"Status\" = 'Reversed'")) {
      const payment = state.payments.find((row) => row.Id === values[2]);
      if (!payment || payment.Version !== Number(values[3]) || payment.Status !== 'Verified') return empty;
      payment.Status = 'Reversed';
      payment.StatusReason = values[0];
      payment.Version += 1;
      return { rows: [{ Id: payment.Id }] };
    }
    if (sql.includes('INSERT INTO "Receipts"')) {
      const receipt = {
        Id: values[0], Amount: String(values[1]), BalanceAfter: String(values[2]),
        BusinessId: values[3], InvoiceId: values[4], IssuedAtUtc: '2026-10-17T12:00:00.000Z',
        Number: values[5], PaymentId: values[6], VoidedAtUtc: null,
      };
      state.receipts.push(receipt);
      return { rows: [receipt] };
    }
    if (sql.includes('INSERT INTO "DocumentCounters"')) {
      state.counter += 1;
      return { rows: [{ LastValue: state.counter }] };
    }
    if (sql.includes('UPDATE "Receipts"')) {
      const receipt = state.receipts.find((row) => row.BusinessId === values[0] && row.PaymentId === values[1]);
      if (receipt) receipt.VoidedAtUtc = '2026-10-17T13:00:00.000Z';
      return empty;
    }
    if (sql.includes('INSERT INTO "AuditLogs"')) {
      state.audit.push({ action: values[1], details: values[4] });
      return empty;
    }
    if (sql.includes('SELECT "Id" FROM "Receipts"')) {
      const receipt = state.receipts.find((row) => row.BusinessId === values[0] && row.PaymentId === values[1]);
      return { rows: receipt ? [{ Id: receipt.Id }] : [] };
    }
    if (sql.includes('FROM "Receipts" r')) {
      const receipt = state.receipts.find((row) => row.BusinessId === values[0] && row.Id === values[1]);
      if (!receipt) return empty;
      if (values[2] && (!state.invoice.OrderId || !values[2].includes(state.invoice.OrderLocationId))) return empty;
      return { rows: [{
        ...receipt, InvoiceNumber: state.invoice.Number, CustomerId: state.invoice.CustomerId,
        CurrencyCode: state.invoice.CurrencyCode, CustomerName: 'Test customer',
        Method: state.payments.find((p) => p.Id === receipt.PaymentId)?.Method, Reference: null,
      }] };
    }
    // Step 16b: issuing a receipt queues the customer's receipt message (a customer who has not opted in gets no row; the fake records the call).
    if (sql.includes('INSERT INTO "CustomerEventOutbox"')) {
      state.customerEvents.push({ businessId: values[0], customerId: values[1], kind: values[2], subjectId: values[3], dedupeKey: values[4] });
      return { rows: [] };
    }
    throw new Error(`Unexpected payment query: ${sql}`);
  }

  return {
    state,
    query,
    connect: async () => ({ query, release() {} }),
  };
}

const transaction = (pool, callback) => pool.connect().then(async (client) => {
  await client.query('BEGIN');
  try {
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

describe('payment and receipt persistence', () => {
  it('records a payment claim as pending, idempotently, with tenant and invoice checks', async () => {
    const pool = createPool();
    const input = { amount: 40, method: 'BankTransfer', receivedOn: null, verifyNow: false };
    const first = await recordPayment(pool, transaction, user, invoiceId, input, 'pay-key-1', null);
    assert.equal(first.created, true);
    assert.equal(first.payment.status, 'Pending');
    assert.equal(pool.state.notifications.length, 1);
    assert.equal(pool.state.notifications[0].eventType, 'payment.recorded');
    assert.equal(first.payment.amount, 40);
    assert.equal(first.payment.receiptId, null);
    const retry = await recordPayment(pool, transaction, user, invoiceId, input, 'pay-key-1', null);
    assert.equal(retry.created, false);
    assert.equal(retry.payment.id, first.payment.id);
    await assert.rejects(
      recordPayment(pool, transaction, user, invoiceId, { ...input, amount: 41 }, 'pay-key-1', null),
      (error) => error.code === 'idempotency_key_reused',
    );
    assert.equal(pool.state.audit.filter((row) => row.action === 'payment.recorded').length, 1);
  });

  it('verifies immediately only for authorized staff and issues receipt with the remaining balance', async () => {
    const pool = createPool();
    const recorded = await recordPayment(pool, transaction, user, invoiceId, {
      amount: 100, method: 'Cash', verifyNow: true,
    }, 'pay-key-2', null);
    assert.equal(recorded.payment.status, 'Verified');
    assert.equal(recorded.payment.receiptNumber, 'RCT-2026-00001');
    assert.equal(Number(pool.state.receipts[0].BalanceAfter), 0);
    assert.equal(pool.state.audit[0].action, 'payment.recorded');
    assert.equal(pool.state.receipts.length, 1);
    assert.deepEqual(pool.state.customerEvents, [{
      businessId: user.businessId, customerId: '00000000-0000-4000-8000-000000000010', kind: 'payment.receipt',
      subjectId: recorded.payment.id, dedupeKey: `payment.receipt:${recorded.payment.id}`,
    }], 'the customer\'s receipt message is queued with the receipt, keyed by the payment');

    const restrictedUser = { ...user, isOwner: false, permissions: [] };
    const anotherPool = createPool();
    const pending = await recordPayment(anotherPool, transaction, restrictedUser, invoiceId, {
      amount: 100, method: 'Cash', verifyNow: true,
    }, null, null);
    assert.equal(pending.payment.status, 'Pending');
    assert.equal(anotherPool.state.receipts.length, 0);
    assert.equal(anotherPool.state.customerEvents.length, 0, 'a payment still waiting for verification sends no receipt');
  });

  it('rejects overpayments, unsupported partial payments, future dates, and non-issued invoices', async () => {
    const pool = createPool({ entitlement: 'false' });
    await assert.rejects(
      recordPayment(pool, transaction, user, invoiceId, { amount: 40, method: 'Cash', verifyNow: false }, null, null),
      (error) => error.code === 'feature_not_in_plan',
    );
    await assert.rejects(
      recordPayment(pool, transaction, user, invoiceId, { amount: 101, method: 'Cash', verifyNow: false }, null, null),
      (error) => error.code === 'overpayment',
    );
    await assert.rejects(
      recordPayment(createPool(), transaction, user, invoiceId, {
        amount: 100, method: 'Cash', receivedOn: '2026-10-18', verifyNow: false,
      }, null, null),
      (error) => error.code === 'received_in_future',
    );
    await assert.rejects(
      recordPayment(createPool({ invoice: { ...createPool().state.invoice, Status: 'Draft' } }),
        transaction, user, invoiceId, { amount: 100, method: 'Cash', verifyNow: false }, null, null),
      (error) => error.code === 'invoice_not_payable',
    );
  });

  it('filters paginated payment history by invoice and location', async () => {
    const pool = createPool();
    pool.state.payments.push({
      Id: paymentId, Amount: '20.00', BusinessId: businessId, CurrencyCode: 'USD',
      CustomerId: '00000000-0000-4000-8000-000000000010', InvoiceId: invoiceId,
      Method: 'Cash', Reference: 'REF-1', ReceivedOn: '2026-10-10', Status: 'Pending',
      CreatedAtUtc: '2026-10-10T10:00:00.000Z', Version: 1,
    });
    const result = await listPayments(pool, user, { page: 1, pageSize: 10, invoiceId, status: 'pending' }, [locationId]);
    assert.equal(result.totalCount, 1);
    assert.equal(result.items[0].status, 'Pending');
    assert.equal(result.items[0].invoiceNumber, 'INV-2026-00001');
  });

  it('only permits valid pending-to-verified/rejected and verified-to-reversed transitions', async () => {
    const pool = createPool();
    const pending = await recordPayment(pool, transaction, user, invoiceId, {
      amount: 40, method: 'Card', verifyNow: false,
    }, null, null);
    const verified = await verifyPayment(pool, transaction, user, pending.payment.id, null);
    assert.equal(verified.status, 'Verified');
    assert.equal(verified.receiptId !== null, true);
    await assert.rejects(
      verifyPayment(pool, transaction, user, pending.payment.id, null),
      (error) => error.code === 'invalid_transition',
    );
    const reversed = await reversePayment(pool, transaction, user, pending.payment.id, 'Refund issued', null);
    assert.equal(reversed.status, 'Reversed');
    assert.equal(reversed.statusReason, 'Refund issued');
    assert.notEqual(pool.state.receipts[0].VoidedAtUtc, null);

    const poolToReject = createPool();
    const pendingReject = await recordPayment(poolToReject, transaction, user, invoiceId, {
      amount: 40, method: 'Other', verifyNow: false,
    }, null, null);
    const rejected = await rejectPayment(poolToReject, transaction, user, pendingReject.payment.id, 'Proof invalid', null);
    assert.equal(rejected.status, 'Rejected');
    assert.equal(rejected.statusReason, 'Proof invalid');
    await assert.rejects(
      reversePayment(poolToReject, transaction, user, pendingReject.payment.id, 'Not verified', null),
      (error) => error.code === 'invalid_transition',
    );
  });

  it('returns tenant/location-scoped receipts and hides missing receipts', async () => {
    const pool = createPool();
    const verified = await recordPayment(pool, transaction, user, invoiceId, {
      amount: 100, method: 'MobileMoney', verifyNow: true,
    }, null, null);
    const byId = await getReceipt(pool, user, verified.payment.receiptId, null);
    const byPayment = await getReceiptForPayment(pool, user, verified.payment.id, null);
    assert.equal(byId.number, byPayment.number);
    assert.equal(byId.customerName, 'Test customer');
    assert.equal(byId.method, 'MobileMoney');
    await assert.rejects(
      getReceipt(pool, user, verified.payment.receiptId, []),
      (error) => error.code === 'receipt_not_found',
    );
    await assert.rejects(
      getReceiptForPayment(pool, user, '00000000-0000-4000-8000-000000000099', null),
      (error) => error.code === 'payment_not_found',
    );
    await assert.rejects(
      getPayment(pool, user, '00000000-0000-4000-8000-000000000099', null),
      (error) => error.code === 'payment_not_found',
    );
  });
});
