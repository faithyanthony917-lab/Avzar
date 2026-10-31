process.env.NODE_ENV = 'test';
process.env.AVZAR_NOW = '2026-10-17T12:00:00.000Z';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addInvoiceCreditNote,
  createInvoice,
  createInvoiceFromOrder,
  deleteDraftInvoice,
  issueDraftInvoice,
  listInvoices,
  updateDraftInvoice,
  voidInvoice,
} from '../src/auth/invoiceService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000010';
const invoiceId = '00000000-0000-4000-8000-000000000030';
const orderId = '00000000-0000-4000-8000-000000000040';
const locationId = '00000000-0000-4000-8000-000000000060';
const user = { businessId, userId, isOwner: true, permissions: [] };
const empty = { rows: [] };

function invoice(overrides = {}) {
  return {
    Id: invoiceId,
    BusinessId: businessId,
    Number: null,
    Kind: 'Standard',
    Status: 'Draft',
    CustomerId: customerId,
    CustomerName: 'Test customer',
    OrderId: null,
    OrderNumber: null,
    CurrencyCode: 'USD',
    IssueDate: null,
    DueDate: null,
    Notes: null,
    Terms: null,
    Subtotal: '100.00',
    TaxTotal: '15.00',
    Total: '115.00',
    AmountPaid: '0',
    AmountPending: '0',
    AmountCredited: '0',
    VoidReason: null,
    Version: '9',
    CreatedAtUtc: '2026-10-17T10:00:00.000Z',
    IssuedAtUtc: null,
    ...overrides,
  };
}

function standardPool(query) {
  return { query };
}

function transactionPool(query) {
  const client = {
    query: async (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return empty;
      return query(sql, values);
    },
    release() {},
  };
  return { connect: async () => client };
}

function transaction(pool, callback) {
  return pool.connect().then(async (client) => {
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
}

function detailQuery(sql) {
  if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
  if (sql.includes('FROM "InvoiceLines"')) return { rows: [] };
  if (sql.includes('FROM "Payments" p')) return { rows: [] };
  if (sql.includes('FROM "CreditNotes"')) return { rows: [] };
  throw new Error(`Unexpected invoice detail query: ${sql}`);
}

describe('invoice persistence', () => {
  it('lists paginated invoices with derived balances and location filtering', async () => {
    const calls = [];
    const issued = invoice({
      Status: 'Issued', Number: 'INV-2026-00001', IssueDate: '2026-10-01', DueDate: '2026-10-10',
      AmountPaid: '20.00', AmountCredited: '5.00',
    });
    const pool = standardPool(async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
      if (sql.includes('count(*)')) return { rows: [{ TotalCount: 1 }] };
      return { rows: [issued] };
    });
    const result = await listInvoices(pool, user, {
      page: 2, pageSize: 10, status: 'Issued', customerId, outstanding: true, overdue: true, search: 'Test_',
    }, [locationId]);
    assert.equal(result.page, 2);
    assert.equal(result.items[0].balance, 90);
    assert.equal(result.items[0].paymentStatus, 'PartPaid');
    assert.equal(result.items[0].isOverdue, true);
    const count = calls.find(({ sql }) => sql.includes('count(*)'));
    assert.match(count.sql, /scoped_order\."LocationId" = ANY\(\$2::uuid\[\]\)/);
    assert.match(count.sql, /i\."Status" = 'Issued'/);
    assert.deepEqual(count.values.slice(0, 3), [businessId, [locationId], 'Issued']);
  });

  it('creates a calculated draft atomically and replays idempotency keys', async () => {
    const queries = [];
    let saved = null;
    const initialPool = standardPool(async (sql, values) => {
      if (sql.includes('SELECT i.*, i.xmin::text::bigint AS "Version"')) return empty;
      if (sql.includes('FROM "Customers"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
      if (sql.includes('FROM "PricingProfiles"')) return { rows: [{ TaxPercent: '15' }] };
      throw new Error(`Unexpected pre-transaction query: ${sql}`);
    });
    const txPool = transactionPool(async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO "Invoices"')) {
        saved = invoice({
          Id: values[0], DueDate: values[5], Notes: values[7], Subtotal: String(values[8]),
          TaxTotal: String(values[9]), Terms: values[10], Total: String(values[11]),
          Version: '1', CreatedAtUtc: '2026-10-17T12:00:00.000Z',
        });
        return { rows: [saved] };
      }
      if (sql.includes('INSERT INTO "InvoiceLines"')) {
        return { rows: [{
          Id: values[0], BusinessId: values[1], Description: values[2], Discount: values[3],
          InvoiceId: values[4], LineNumber: values[5], LineTotal: values[6], NetAmount: values[7],
          Quantity: values[8], TaxAmount: values[9], TaxPercent: values[10], UnitPrice: values[11],
        }] };
      }
      if (sql.includes('INSERT INTO "AuditLogs"')) return empty;
      if (sql.includes('FROM "Invoices" i')) return { rows: [saved] };
      if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
      if (sql.includes('FROM "InvoiceLines"')) return { rows: [{
        Id: '00000000-0000-4000-8000-000000000031', LineNumber: 1, Description: 'Alteration',
        Quantity: '2', UnitPrice: '50', Discount: '0', TaxPercent: '15', NetAmount: '100',
        TaxAmount: '15', LineTotal: '115',
      }] };
      if (sql.includes('FROM "Payments" p') || sql.includes('FROM "CreditNotes"')) return empty;
      throw new Error(`Unexpected transaction query: ${sql}`);
    });
    const pool = { ...initialPool, connect: txPool.connect };
    const payload = {
      customerId,
      dueDate: '2026-11-01',
      notes: ' Alterations ',
      lines: [{ description: 'Alteration', quantity: 2, unitPrice: 50 }],
    };
    const created = await createInvoice(pool, transaction, user, payload, 'invoice-create-1', null);
    assert.equal(created.created, true);
    assert.equal(created.invoice.total, 115);
    assert.equal(created.invoice.lines[0].taxAmount, 15);
    assert.equal(created.invoice.notes, 'Alterations');
    assert.equal(queries.some(({ sql }) => sql.includes('INSERT INTO "AuditLogs"')), true);

    const replayPool = standardPool(async (sql) => {
      if (sql.includes('SELECT i.*, i.xmin::text::bigint AS "Version"')) return { rows: [{ ...saved, CustomerName: 'Test customer' }] };
      return detailQuery(sql);
    });
    const replay = await createInvoice(replayPool, transaction, user, payload, 'invoice-create-1', null);
    assert.equal(replay.created, false);
    assert.equal(replay.invoice.id, saved.Id);
  });

  it('creates a full order invoice with the order discount allocated exactly across lines', async () => {
    const insertedLines = [];
    let savedInvoice;
    const pool = {
      query: async (sql) => {
        if (sql.includes('SELECT i.*, i.xmin::text::bigint AS "Version"')) return empty;
        if (sql.includes('FROM "PricingProfiles"')) return { rows: [{ TaxPercent: '0' }] };
        throw new Error(`Unexpected order invoice query: ${sql}`);
      },
      connect: async () => ({
        query: async (sql, values) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return empty;
          if (sql.includes('FROM "Orders"')) return { rows: [{
            Id: orderId, CustomerId: customerId, OrderNumber: 'ORD-2026-00001',
            CurrencyCode: 'USD', Status: 'Confirmed', Total: '99', Discount: '1', LocationId: locationId,
          }] };
          if (sql.includes('sum("Subtotal")')) return { rows: [{ Billed: '0' }] };
          if (sql.includes('FROM "OrderGarments"')) return { rows: [
            { LineNumber: 1, Name: 'Garment A', Quantity: 1, UnitPrice: '50' },
            { LineNumber: 2, Name: 'Garment B', Quantity: 1, UnitPrice: '50' },
          ] };
          if (sql.includes('INSERT INTO "Invoices"')) {
            savedInvoice = invoice({
              Id: values[0], Kind: values[7], OrderId: values[9], OrderNumber: 'ORD-2026-00001',
              Subtotal: String(values[10]), TaxTotal: String(values[11]), Total: String(values[13]),
              Version: '1',
            });
            return empty;
          }
          if (sql.includes('INSERT INTO "InvoiceLines"')) {
            insertedLines.push(values);
            return empty;
          }
          if (sql.includes('INSERT INTO "AuditLogs"')) return empty;
          if (sql.includes('FROM "Invoices" i')) return { rows: [savedInvoice] };
          if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
          if (sql.includes('FROM "InvoiceLines"')) return { rows: insertedLines.map((values, index) => ({
            Id: `00000000-0000-4000-8000-00000000003${index + 1}`,
            BusinessId: businessId,
            Description: values[2],
            Discount: String(values[3]),
            InvoiceId: values[4],
            LineNumber: values[5],
            LineTotal: String(values[6]),
            NetAmount: String(values[7]),
            Quantity: String(values[8]),
            TaxAmount: String(values[9]),
            TaxPercent: String(values[10]),
            UnitPrice: String(values[11]),
          })) };
          if (sql.includes('FROM "Payments" p') || sql.includes('FROM "CreditNotes"')) return empty;
          throw new Error(`Unexpected order invoice query: ${sql}`);
        },
        release() {},
      }),
    };
    const result = await createInvoiceFromOrder(pool, transaction, user, orderId, {
      mode: 'Full', taxPercent: 0,
    }, null, null);
    assert.equal(result.created, true);
    assert.equal(result.invoice.orderId, orderId);
    assert.equal(result.invoice.subtotal, 99);
    assert.deepEqual(insertedLines.map((line) => line[3]), [0.5, 0.5]);
  });

  it('rejects stale draft updates and deletes only drafts', async () => {
    let updateCalled = false;
    const staleDb = transactionPool(async (sql) => {
      if (sql.includes('FROM "Invoices" i')) return { rows: [invoice()] };
      if (sql.includes('UPDATE "Invoices"')) updateCalled = true;
      return empty;
    });
    await assert.rejects(
      updateDraftInvoice(staleDb, transaction, user, invoiceId, {
        version: 8, dueDate: '2026-11-01', notes: null, terms: null,
      }, null),
      (error) => error.code === 'stale_version',
    );
    assert.equal(updateCalled, false);

    const issuedDb = transactionPool(async (sql) => sql.includes('FROM "Invoices" i')
      ? { rows: [invoice({ Status: 'Issued' })] }
      : empty);
    await assert.rejects(
      deleteDraftInvoice(issuedDb, transaction, user, invoiceId, null),
      (error) => error.code === 'invoice_not_draft',
    );
  });

  it('issues drafts with a transactional yearly number and fourteen-day default due date', async () => {
    const calls = [];
    let issued = null;
    const txPool = transactionPool(async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('pg_advisory_xact_lock')) return empty;
      if (sql.includes('FROM "Invoices" i')) return { rows: [issued ?? invoice()] };
      if (sql.includes('INSERT INTO "DocumentCounters"')) return { rows: [{ LastValue: '42' }] };
      if (sql.includes('UPDATE "Invoices"')) {
        issued = invoice({
        Status: 'Issued', Number: 'INV-2026-00042', IssueDate: values[1], DueDate: values[2],
        Version: '10', IssuedAtUtc: '2026-10-17T12:00:00.000Z',
        });
        return { rows: [issued] };
      }
      if (sql.includes('INSERT INTO "AuditLogs"')) return empty;
      if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
      if (sql.includes('FROM "InvoiceLines"')) return { rows: [] };
      if (sql.includes('FROM "Payments" p') || sql.includes('FROM "CreditNotes"')) return empty;
      throw new Error(`Unexpected transaction query: ${sql}`);
    });
    const pool = {
      query: async (sql) => sql.includes('SELECT "CurrencyCode", "TimeZoneId"')
        ? { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] }
        : empty,
      connect: txPool.connect,
    };
    const result = await issueDraftInvoice(pool, transaction, user, invoiceId, null);
    assert.equal(result.number, 'INV-2026-00042');
    assert.equal(result.status, 'Issued');
    assert.equal(result.dueDate, '2026-10-31');
    assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO "DocumentCounters"')), true);
  });

  it('voids issued invoices only when no live payment or credit note exists', async () => {
    const calls = [];
    let voided;
    const pool = transactionPool(async (sql, values) => {
      calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return empty;
      if (sql.includes('FROM "Invoices" i')) return { rows: [voided ?? invoice({ Status: 'Issued', Number: 'INV-2026-00001' })] };
      if (sql.includes('FROM "Payments"')) return empty;
      if (sql.includes('FROM "CreditNotes"')) return empty;
      if (sql.includes('UPDATE "Invoices"')) {
        voided = invoice({
          Status: 'Void', Number: 'INV-2026-00001', VoidReason: values[0],
          VoidedAtUtc: '2026-10-17T12:00:00.000Z', Version: '10',
        });
        return { rows: [{ Id: invoiceId }] };
      }
      if (sql.includes('UPDATE "InvoiceInstallmentPlans"')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO "AuditLogs"')) return empty;
      return detailQuery(sql);
    });
    const result = await voidInvoice(pool, transaction, user, invoiceId, 'Duplicate invoice', null);
    assert.equal(result.status, 'Void');
    assert.equal(result.voidReason, 'Duplicate invoice');
    assert.equal(result.balance, 0);
    assert.equal(calls.some((sql) => sql.includes('INSERT INTO "AuditLogs"')), true);

    const blockedPool = transactionPool(async (sql) => {
      if (sql.includes('FROM "Invoices" i')) return { rows: [invoice({ Status: 'Issued' })] };
      if (sql.includes('FROM "Payments"')) return { rows: [{ '?column?': 1 }] };
      return empty;
    });
    await assert.rejects(
      voidInvoice(blockedPool, transaction, user, invoiceId, 'Duplicate invoice', null),
      (error) => error.code === 'invoice_has_payments',
    );
  });

  it('requires the partial-payments entitlement and caps a credit note at the live balance', async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
        return empty;
      },
      connect: async () => {
        let credited;
        return {
          query: async (sql, values) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return empty;
            if (sql.includes('pg_advisory_xact_lock')) return empty;
            if (sql.includes('FROM "Invoices" i')) return { rows: [invoice({
              Status: 'Issued', Number: 'INV-2026-00001', AmountPaid: '20',
              AmountCredited: credited ? '10' : '0',
            })] };
            if (sql.includes('INSERT INTO "DocumentCounters"')) return { rows: [{ LastValue: '7' }] };
            if (sql.includes('INSERT INTO "CreditNotes"')) {
              credited = { amount: values[5], reason: values[6] };
              return empty;
            }
            if (sql.includes('INSERT INTO "AuditLogs"')) return empty;
            if (sql.includes('SELECT "CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
            if (sql.includes('FROM "InvoiceLines"')) return empty;
            if (sql.includes('FROM "Payments" p')) return empty;
            if (sql.includes('FROM "CreditNotes"')) {
              return credited ? { rows: [{
                Id: '00000000-0000-4000-8000-000000000032', Number: 'CN-2026-00007',
                Amount: credited.amount, Reason: credited.reason, CreatedAtUtc: '2026-10-17T12:00:00.000Z',
              }] } : empty;
            }
            throw new Error(`Unexpected credit note query: ${sql}`);
          },
          release() {},
        };
      },
    };
    await assert.rejects(
      addInvoiceCreditNote(pool, transaction, user, invoiceId, { amount: 100, reason: 'Price correction' }, null),
      (error) => error.code === 'credit_exceeds_balance',
    );
    const result = await addInvoiceCreditNote(pool, transaction, user, invoiceId, { amount: 10, reason: 'Price correction' }, null);
    assert.equal(result.status, 'Issued');
    assert.equal(result.balance, 85);
    assert.equal(result.creditNotes[0].number, 'CN-2026-00007');
  });
});
