export interface Paged<T> { items: T[]; page: number; pageSize: number; totalCount: number }
export interface InvoiceSummary {
  id: string; number: string | null; kind: string; status: string; customerId: string; customerName: string;
  orderId: string | null; currencyCode: string; total: number; amountPaid: number; amountCredited: number; balance: number;
  paymentStatus: string | null; isOverdue: boolean; issueDate: string | null; dueDate: string | null;
}
export interface Payment {
  id: string; invoiceId: string; invoiceNumber: string | null; customerId: string; amount: number; currencyCode: string;
  method: string; reference: string | null; receivedOn: string; status: string; notes: string | null; statusReason: string | null;
  receiptId: string | null; receiptNumber: string | null; version: number; createdAtUtc: string;
}
export interface InvoiceLine { id: string; lineNumber: number; description: string; quantity: number; unitPrice: number; discount: number; taxPercent: number; netAmount: number; taxAmount: number; lineTotal: number }
export interface CreditNote { id: string; number: string; amount: number; reason: string; createdAtUtc: string }
export interface Invoice {
  id: string; number: string | null; kind: string; status: string; customerId: string; customerName: string; orderId: string | null;
  orderNumber: string | null; currencyCode: string; issueDate: string | null; dueDate: string | null; notes: string | null; terms: string | null;
  subtotal: number; taxTotal: number; total: number; amountPaid: number; amountPending: number; amountCredited: number; balance: number;
  paymentStatus: string | null; isOverdue: boolean; voidReason: string | null; version: number; createdAtUtc: string; issuedAtUtc: string | null;
  lines: InvoiceLine[]; payments: Payment[]; creditNotes: CreditNote[];
}
export interface ExpenseSummary { currencyCode: string; from: string | null; to: string | null; total: number; byCategory: { categoryId: string; categoryName: string; total: number; count: number }[] }
export function money(amount: number, currency: string): string {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount); }
  catch { return `${currency} ${amount.toFixed(2)}`; }
}
