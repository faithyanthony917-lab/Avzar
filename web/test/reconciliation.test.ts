import { describe, expect, it } from 'vitest';
import { attentionSummary, cutNote, methodLabel, reasonLabel, reconciliationCsv, type ReconciliationReport } from '@/lib/reconciliation';

const empty = { count: 0, amount: 0, truncated: false, items: [] };
const base = (over: Partial<ReconciliationReport> = {}): ReconciliationReport => ({
  from: '2026-10-01', to: '2026-10-27', asOf: '2026-10-27', currencyCode: 'NGN', attentionCount: 0,
  collected: { count: 0, amount: 0, online: { count: 0, amount: 0 }, staffRecorded: { count: 0, amount: 0 }, byMethod: [] },
  needsAttention: {
    needsReviewPayments: empty, staleLinks: empty, pendingVerification: { ...empty, thresholdDays: 3 }, paymentsOnVoidedInvoices: empty, onlineMismatches: empty,
  },
  invoices: { openCount: 0, openBalance: 0, overdueCount: 0, overdueBalance: 0, installmentsOverdue: { plans: 0, installments: 0, amount: 0, truncated: false, items: [] } },
  ...over,
});
const ref = { invoiceId: 'i1', invoiceNumber: 'INV-1', amount: 120, currencyCode: 'NGN', reference: 'ref-1' };

describe('reconciliation wording', () => {
  it('says plainly when nothing or something needs attention', () => {
    expect(attentionSummary(0)).toBe('Nothing needs attention in this report.');
    expect(attentionSummary(1)).toBe('1 item needs attention.');
    expect(attentionSummary(5)).toBe('5 items need attention.');
  });

  it('says when a list was cut and stays silent otherwise', () => {
    expect(cutNote({ count: 73, truncated: true, items: new Array(50) })).toBe('Showing the first 50 of 73. Narrow the dates to see the rest.');
    expect(cutNote({ count: 3, truncated: false, items: new Array(3) })).toBeNull();
  });

  it('explains the known reasons and falls back to the stored text', () => {
    expect(reasonLabel('overpayment')).toMatch(/already paid or credited/);
    expect(reasonLabel('invoice_not_payable')).toMatch(/voided/);
    expect(reasonLabel('something_new')).toBe('something_new');
    expect(reasonLabel(null)).toBe('No reason recorded.');
    expect(methodLabel('BankTransfer')).toBe('Bank transfer');
    expect(methodLabel('Cash')).toBe('Cash');
  });
});

describe('reconciliation CSV', () => {
  it('has only the header row for an empty report', () => {
    const csv = reconciliationCsv(base());
    expect(csv.headers).toEqual(['Section', 'Invoice', 'Amount', 'Currency', 'Reference', 'Method', 'Detail', 'Date']);
    expect(csv.rows).toEqual([]);
  });

  it('has one row per collected line and per finding, every row as wide as the header', () => {
    const report = base({
      collected: { count: 3, amount: 350, online: { count: 2, amount: 300 }, staffRecorded: { count: 1, amount: 50 },
        byMethod: [{ method: 'Card', online: true, count: 2, amount: 300 }, { method: 'BankTransfer', online: false, count: 1, amount: 50 }] },
      needsAttention: {
        ...base().needsAttention,
        needsReviewPayments: { count: 1, amount: 120, truncated: false, items: [{ ...ref, id: 'a1', reason: 'overpayment', source: 'Portal', updatedAtUtc: '2026-10-20T10:00:00.000Z' }] },
        onlineMismatches: { count: 1, amount: 120, truncated: false, items: [{ ...ref, id: 'a2', paymentId: 'p', paymentStatus: 'Reversed', paymentAmount: 120, kind: 'reversed', note: 'Reversed in Avzar.' }] },
      },
      invoices: { ...base().invoices, installmentsOverdue: { plans: 1, installments: 2, amount: 80, truncated: false, items: [{ invoiceId: 'i2', invoiceNumber: 'INV-2', overdueCount: 2, overdueAmount: 80, oldestDueDate: '2026-10-01', matchesInvoice: false }] } },
    });
    const { headers, rows } = reconciliationCsv(report);
    expect(rows.map((row) => row[0])).toEqual(['Collected', 'Collected', 'Money to review', 'Online payment mismatch', 'Overdue installments']);
    expect(rows.every((row) => row.length === headers.length)).toBe(true);
    expect(rows[0]![5]).toBe('Card (online)');
    expect(rows[1]![5]).toBe('Bank transfer');
    expect(rows[2]).toEqual(['Money to review', 'INV-1', 120, 'NGN', 'ref-1', 'Card', 'The invoice was already paid or credited when the money arrived.', '2026-10-20']);
    expect(rows[4]![6]).toBe('2 overdue (plan does not match the invoice)');
  });

  it('adds a row saying a list was cut, so a spreadsheet is never mistaken for the whole picture', () => {
    const report = base({ needsAttention: { ...base().needsAttention, staleLinks: { count: 73, amount: 1, truncated: true, items: [] } } });
    const { rows } = reconciliationCsv(report);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe('Expired unpaid link');
    expect(rows[0]![6]).toBe('List cut: 0 of 73 shown');
  });
});
