import { ApiError, messageFor } from './problem';

export type InstallmentRow = {
  sequence: number; dueDate: string; originalAmount?: number; amount: number; paid: number; outstanding: number;
  status: 'Paid' | 'PartPaid' | 'Due' | 'Credited' | string; overdue: boolean;
};
export type InstallmentNext = { sequence: number; dueDate: string; amount: number; overdue: boolean; payAmount: number };
export type InstallmentPlan = {
  id?: string; state: 'Active' | 'Completed' | string; currencyCode: string; note?: string | null; createdAtUtc?: string;
  invoiceBalance?: number; matchesInvoice?: boolean; outstanding: number; overdueCount: number;
  installments: InstallmentRow[]; next: InstallmentNext | null;
};

const STATUS_LABELS: Record<string, string> = { Paid: 'Paid', PartPaid: 'Part paid', Due: 'Due', Credited: 'Credited' };
/** The badge text of one installment. An unpaid or part-paid installment past its own date reads Overdue. */
export function installmentLabel(row: Pick<InstallmentRow, 'status' | 'overdue'>): string {
  if (row.overdue) return 'Overdue';
  return STATUS_LABELS[row.status] ?? row.status;
}
export const installmentBadgeClass = (row: Pick<InstallmentRow, 'status' | 'overdue'>) =>
  row.overdue ? 'ap-badge ap-badge-off' : row.status === 'Paid' ? 'ap-badge ap-badge-on' : 'ap-badge';

const cents = (value: number) => Math.round(value * 100);

export type CustomRow = { dueDate: string; amount: string };

/** Checks a custom list on the screen before sending it: dates in order, amounts above zero, the total equal to the balance. Returns a message or ''. */
export function customPlanProblem(rows: CustomRow[], balance: number): string {
  if (rows.length < 2) return 'Add at least two installments.';
  if (rows.length > 24) return 'Use no more than 24 installments.';
  let total = 0;
  let previous = '';
  for (const [index, row] of rows.entries()) {
    const amount = Number(row.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)) return `Choose a due date for installment ${index + 1}.`;
    if (previous && row.dueDate <= previous) return 'Due dates must be in order, one after another.';
    previous = row.dueDate;
    if (!/^\d+(\.\d{1,2})?$/.test(row.amount.trim()) || amount <= 0) return `Enter an amount above zero (2 decimal places at most) for installment ${index + 1}.`;
    total += cents(amount);
  }
  if (total !== cents(balance)) return `The installments add up to ${(total / 100).toFixed(2)} but the balance is ${balance.toFixed(2)}.`;
  return '';
}

/** Plain-language messages for the refusals a person can fix. Anything else falls back to the server's own message. */
export function installmentMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'feature_not_in_plan') return 'Your plan does not include payment plans. Upgrade to split an invoice into installments.';
    if (err.code === 'installment_plan_exists') return 'This invoice already has a payment plan. Cancel it before making a different one.';
    if (err.code === 'invoice_not_payable') return 'Only issued invoices can have a payment plan.';
    if (err.code === 'nothing_owed') return 'This invoice has nothing left to pay.';
    if (err.code === 'installments_do_not_match_balance') return err.message;
  }
  return messageFor(err);
}
