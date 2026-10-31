import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_LIMIT, MAX_RANGE_DAYS, STALE_PENDING_DAYS, attentionCount, parseRange, section, summarizeCollected, summarizeOverdueInstallments,
} from '../src/auth/reconciliationReport.js';

// Step 15c: the pure rules of the reconciliation report. No database, no network.

describe('reconciliation range', () => {
  it('defaults to the last 30 days ending today', () => {
    const range = parseRange(undefined, undefined, '2026-10-27');
    assert.equal(range.to, '2026-10-27');
    assert.equal(range.from, '2026-09-28');
    assert.equal(range.fromUtc, '2026-09-28T00:00:00.000Z');
    assert.equal(range.untilUtc, '2026-10-28T00:00:00.000Z');
  });

  it('accepts exactly 92 days and refuses 93, a reversed range, and anything that is not a real date', () => {
    assert.equal(MAX_RANGE_DAYS, 92);
    assert.doesNotThrow(() => parseRange('2026-07-28', '2026-10-27', '2026-10-27'));
    assert.throws(() => parseRange('2026-07-27', '2026-10-27', '2026-10-27'), { code: 'invalid_report_range', status: 400 });
    assert.throws(() => parseRange('2026-10-27', '2026-10-26', '2026-10-27'), { code: 'invalid_report_range' });
    assert.throws(() => parseRange('2026-02-30', '2026-03-01', '2026-10-27'), { code: 'invalid_report_range' });
    assert.throws(() => parseRange('yesterday', undefined, '2026-10-27'), { code: 'invalid_report_range' });
    assert.throws(() => parseRange(['2026-10-01'], undefined, '2026-10-27'), { code: 'invalid_report_range' });
  });

  it('treats a single day as a valid range and ends the window at the start of the next day', () => {
    const range = parseRange('2026-12-31', '2026-12-31', '2026-12-31');
    assert.equal(range.untilUtc, '2027-01-01T00:00:00.000Z');
  });
});

describe('collected money', () => {
  it('splits online from staff-recorded and sorts methods by amount, adding in whole cents', () => {
    const result = summarizeCollected([
      { Method: 'Cash', Online: false, Count: 2, Amount: '0.10' },
      { Method: 'Card', Online: true, Count: 1, Amount: '0.20' },
      { Method: 'BankTransfer', Online: false, Count: 3, Amount: '1000.00' },
      { Method: 'Card', Online: false, Count: 1, Amount: '50.00' },
    ]);
    assert.equal(result.count, 7);
    assert.equal(result.amount, 1050.3);
    assert.deepEqual(result.online, { count: 1, amount: 0.2 });
    assert.deepEqual(result.staffRecorded, { count: 6, amount: 1050.1 });
    assert.deepEqual(result.byMethod.map((row) => `${row.method}:${row.online}`), ['BankTransfer:false', 'Card:false', 'Card:true', 'Cash:false']);
  });

  it('is all zeros when nothing was collected', () => {
    const result = summarizeCollected([]);
    assert.deepEqual([result.count, result.amount, result.online.count, result.staffRecorded.amount, result.byMethod.length], [0, 0, 0, 0, 0]);
  });
});

describe('finding lists', () => {
  it('keeps at most 50 rows but reports the real count and says when the list is cut', () => {
    const rows = Array.from({ length: LIST_LIMIT + 1 }, (_, i) => ({ id: i }));
    const cut = section(rows, { count: 73, amount: '1234.50' });
    assert.equal(cut.items.length, LIST_LIMIT);
    assert.deepEqual([cut.count, cut.amount, cut.truncated], [73, 1234.5, true]);
    const whole = section(rows.slice(0, 3), { count: 3, amount: '9.99' });
    assert.deepEqual([whole.items.length, whole.truncated], [3, false]);
    assert.deepEqual(section([], { count: undefined, amount: undefined }), { count: 0, amount: 0, truncated: false, items: [] });
  });

  it('counts only findings, not collected money or open invoices', () => {
    const none = { count: 0, amount: 0, truncated: false, items: [] };
    const found = { ...none, count: 2 };
    assert.equal(attentionCount({ needsReviewPayments: none, staleLinks: none, pendingVerification: none, paymentsOnVoidedInvoices: none, onlineMismatches: none }), 0);
    assert.equal(attentionCount({ needsReviewPayments: found, staleLinks: found, pendingVerification: none, paymentsOnVoidedInvoices: found, onlineMismatches: { ...none, count: 1 } }), 7);
    assert.equal(STALE_PENDING_DAYS, 3);
  });
});

describe('overdue installments', () => {
  const plan = (invoiceId, rows, matchesInvoice = true) => ({ invoiceId, matchesInvoice, installments: rows });
  const row = (dueDate, outstanding, overdue) => ({ dueDate, outstanding, overdue });

  it('lists only plans with an overdue installment, adds their amounts in cents and puts the oldest first', () => {
    const numbers = new Map([['a', 'INV-2'], ['b', 'INV-1'], ['c', 'INV-3']]);
    const result = summarizeOverdueInstallments([
      plan('a', [row('2026-10-20', 0.1, true), row('2026-10-25', 0.2, true), row('2026-12-01', 50, false)]),
      plan('b', [row('2026-09-01', 10, true)], false),
      plan('c', [row('2026-12-01', 5, false)]),
    ], numbers);
    assert.deepEqual([result.plans, result.installments, result.amount, result.truncated], [2, 3, 10.3, false]);
    assert.deepEqual(result.items.map((item) => item.invoiceNumber), ['INV-1', 'INV-2']);
    assert.equal(result.items[1].overdueAmount, 0.3);
    assert.equal(result.items[1].oldestDueDate, '2026-10-20');
    assert.equal(result.items[0].matchesInvoice, false);
  });

  it('says the list is cut when more plans exist than were read', () => {
    const result = summarizeOverdueInstallments([plan('a', [row('2026-10-20', 1, true)])], new Map([['a', 'INV-1']]), { planCapReached: true });
    assert.equal(result.truncated, true);
  });

  it('shows no invoice number when the plan is not in the number map, without failing', () => {
    const result = summarizeOverdueInstallments([plan('zzz', [row('2026-10-20', 1, true)])], new Map());
    assert.equal(result.items[0].invoiceNumber, null);
  });
});
