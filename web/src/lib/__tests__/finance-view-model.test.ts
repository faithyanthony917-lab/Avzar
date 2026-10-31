import { describe, expect, it } from 'vitest';
import { canEditInvoiceLines, invoiceBalance, invoiceStatusLabel } from '../finance-view-model';

describe('finance view model', () => {
  it('allows line replacement only for free-form draft invoices', () => {
    expect(canEditInvoiceLines({ status: 'Draft', orderId: null })).toBe(true);
    expect(canEditInvoiceLines({ status: 'Draft', orderId: 'order-1' })).toBe(false);
    expect(canEditInvoiceLines({ status: 'Issued', orderId: null })).toBe(false);
  });
  it('clamps display balance and labels overdue and void invoices', () => {
    expect(invoiceBalance({ total: 10, amountPaid: 11, amountCredited: 0, balance: -1 })).toBe(0);
    expect(invoiceStatusLabel({ status: 'Issued', isOverdue: true, balance: 10 })).toBe('Overdue');
    expect(invoiceStatusLabel({ status: 'Void', isOverdue: false, balance: 0 })).toBe('Void');
  });
});
