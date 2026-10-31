import { ApiError, messageFor } from './problem';

export type PaymentAttempt = {
  id: string; invoiceId: string; amount: number; currencyCode: string;
  status: 'Pending' | 'Paid' | 'Failed' | 'Expired' | 'NeedsReview' | string;
  source: 'Staff' | 'Portal' | string; authorizationUrl: string | null; expiresAtUtc: string; paymentId: string | null; createdAtUtc: string;
};

const STATUS_LABELS: Record<string, string> = {
  Pending: 'Waiting for payment', Paid: 'Paid', Failed: 'Failed', Expired: 'Expired', NeedsReview: 'Needs review',
};
export const attemptStatusLabel = (status: string) => STATUS_LABELS[status] ?? status;

/** Plain-language messages for the refusals a person can fix. Anything else falls back to the server's own message. */
export function onlinePaymentMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'online_payments_not_set_up') return 'Online payments are not set up yet. Add a payout account in Settings first.';
    if (err.code === 'customer_email_required') return 'Add an email address to this customer before taking an online payment.';
    if (err.code === 'invoice_not_payable') return 'Only issued invoices can be paid online.';
    if (err.code === 'payments_unavailable') return 'Online payments are not available right now. Try again later.';
  }
  return messageFor(err);
}
