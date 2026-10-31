// Step 15c: types and presentation rules for the payment reconciliation report (GET /api/reports/reconciliation).

export type Listed<T> = { count: number; amount: number; truncated: boolean; items: T[] };
export type PaymentRef = { invoiceId: string; invoiceNumber: string | null; amount: number; currencyCode: string; reference: string | null };
export type ReviewItem = PaymentRef & { id: string; reason: string | null; source: string; updatedAtUtc: string | null };
export type StaleLinkItem = PaymentRef & { id: string; source: string; createdAtUtc: string | null; expiredAtUtc: string | null };
export type PendingItem = PaymentRef & { id: string; method: string; receivedOn: string | null; createdAtUtc: string | null };
export type VoidedItem = PaymentRef & { id: string; method: string; online: boolean; verifiedAtUtc: string | null };
export type MismatchItem = PaymentRef & { id: string; paymentId: string | null; paymentStatus: string | null; paymentAmount: number | null; kind: string; note: string };
export type OverdueInstallmentItem = { invoiceId: string; invoiceNumber: string | null; overdueCount: number; overdueAmount: number; oldestDueDate: string; matchesInvoice: boolean };
export type CollectedLine = { method: string; online: boolean; count: number; amount: number };

export type ReconciliationReport = {
  from: string; to: string; asOf: string; currencyCode: string; attentionCount: number;
  collected: { count: number; amount: number; online: { count: number; amount: number }; staffRecorded: { count: number; amount: number }; byMethod: CollectedLine[] };
  needsAttention: {
    needsReviewPayments: Listed<ReviewItem>;
    staleLinks: Listed<StaleLinkItem>;
    pendingVerification: Listed<PendingItem> & { thresholdDays: number };
    paymentsOnVoidedInvoices: Listed<VoidedItem>;
    onlineMismatches: Listed<MismatchItem>;
  };
  invoices: {
    openCount: number; openBalance: number; overdueCount: number; overdueBalance: number;
    installmentsOverdue: { plans: number; installments: number; amount: number; truncated: boolean; items: OverdueInstallmentItem[] };
  };
};

export const REASON_LABELS: Record<string, string> = {
  overpayment: 'The invoice was already paid or credited when the money arrived.',
  invoice_not_payable: 'The invoice was voided or no longer open when the money arrived.',
};
export const reasonLabel = (reason: string | null): string => (reason ? (REASON_LABELS[reason] ?? reason) : 'No reason recorded.');

export function attentionSummary(count: number): string {
  if (count === 0) return 'Nothing needs attention in this report.';
  return count === 1 ? '1 item needs attention.' : `${count} items need attention.`;
}

/** "Showing the first 50 of 73." when a list was cut, otherwise null. */
export function cutNote(list: { count: number; truncated: boolean; items: unknown[] }): string | null {
  return list.truncated ? `Showing the first ${list.items.length} of ${list.count}. Narrow the dates to see the rest.` : null;
}

export const methodLabel = (method: string): string => (method === 'BankTransfer' ? 'Bank transfer' : method === 'MobileMoney' ? 'Mobile money' : method);

/** One flat table for a spreadsheet: every finding row, the collected lines and the overdue installments. */
export function reconciliationCsv(report: ReconciliationReport): { headers: string[]; rows: unknown[][] } {
  const headers = ['Section', 'Invoice', 'Amount', 'Currency', 'Reference', 'Method', 'Detail', 'Date'];
  const rows: unknown[][] = [];
  const cur = report.currencyCode;
  for (const line of report.collected.byMethod) {
    rows.push(['Collected', '', line.amount, cur, '', `${methodLabel(line.method)}${line.online ? ' (online)' : ''}`, `${line.count} payment${line.count === 1 ? '' : 's'}`, `${report.from} to ${report.to}`]);
  }
  const { needsAttention: n } = report;
  for (const i of n.needsReviewPayments.items) rows.push(['Money to review', i.invoiceNumber ?? '', i.amount, i.currencyCode, i.reference ?? '', 'Card', reasonLabel(i.reason), i.updatedAtUtc?.slice(0, 10) ?? '']);
  for (const i of n.staleLinks.items) rows.push(['Expired unpaid link', i.invoiceNumber ?? '', i.amount, i.currencyCode, i.reference ?? '', 'Card', 'Check the reference in Paystack before sending a new link.', i.expiredAtUtc?.slice(0, 10) ?? '']);
  for (const i of n.pendingVerification.items) rows.push(['Not verified', i.invoiceNumber ?? '', i.amount, i.currencyCode, i.reference ?? '', methodLabel(i.method), `Recorded and not verified for ${n.pendingVerification.thresholdDays} days or more`, i.receivedOn ?? '']);
  for (const i of n.paymentsOnVoidedInvoices.items) rows.push(['Payment on voided invoice', i.invoiceNumber ?? '', i.amount, i.currencyCode, i.reference ?? '', `${methodLabel(i.method)}${i.online ? ' (online)' : ''}`, 'Refund or reassign', i.verifiedAtUtc?.slice(0, 10) ?? '']);
  for (const i of n.onlineMismatches.items) rows.push(['Online payment mismatch', i.invoiceNumber ?? '', i.amount, i.currencyCode, i.reference ?? '', 'Card', i.note, '']);
  for (const i of report.invoices.installmentsOverdue.items) rows.push(['Overdue installments', i.invoiceNumber ?? '', i.overdueAmount, cur, '', '', `${i.overdueCount} overdue${i.matchesInvoice ? '' : ' (plan does not match the invoice)'}`, i.oldestDueDate]);
  const cutLists: [string, { count: number; truncated: boolean; items: unknown[] }][] = [
    ['Money to review', n.needsReviewPayments], ['Expired unpaid link', n.staleLinks], ['Not verified', n.pendingVerification],
    ['Payment on voided invoice', n.paymentsOnVoidedInvoices], ['Online payment mismatch', n.onlineMismatches],
  ];
  for (const [name, list] of cutLists) if (list.truncated) rows.push([name, '', '', '', '', '', `List cut: ${list.items.length} of ${list.count} shown`, '']);
  if (report.invoices.installmentsOverdue.truncated) rows.push(['Overdue installments', '', '', '', '', '', 'List cut: more plans exist than are shown', '']);
  return { headers, rows };
}
