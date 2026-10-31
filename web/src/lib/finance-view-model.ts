import type { InvoiceSummary } from './finance-types';

/** Only free-form draft invoices may replace line items; order-linked drafts keep their source lines. */
export function canEditInvoiceLines(invoice: Pick<InvoiceSummary, 'status' | 'orderId'>): boolean {
  return invoice.status.toLowerCase() === 'draft' && invoice.orderId === null;
}

export function invoiceBalance(invoice: Pick<InvoiceSummary, 'total' | 'amountPaid' | 'amountCredited' | 'balance'>): number {
  // Prefer the server's balance, but clamp negative rounding artifacts for display.
  if (Number.isFinite(invoice.balance)) return Math.max(0, invoice.balance);
  return Math.max(0, invoice.total - invoice.amountPaid - invoice.amountCredited);
}

export function invoiceStatusLabel(invoice: Pick<InvoiceSummary, 'status' | 'isOverdue' | 'balance'>): string {
  if (invoice.status.toLowerCase() === 'void') return 'Void';
  if (invoice.isOverdue && invoice.balance > 0) return 'Overdue';
  return invoice.status;
}
