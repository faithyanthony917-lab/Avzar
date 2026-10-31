import { AppError } from '../http/errors.js';

// Step 15c: the payment reconciliation report. These are the pure rules (date range, grouping, totals, wording of each finding).
// The queries are in reconciliationService.js. Nothing here reads or changes the database.

export const MAX_RANGE_DAYS = 92;
export const DEFAULT_RANGE_DAYS = 30;
export const LIST_LIMIT = 50;
export const PLAN_LIMIT = 200;
export const STALE_PENDING_DAYS = 3;

const isoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const dayNumber = (value) => Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
export const addDays = (value, count) => new Date((dayNumber(value) + count) * 86_400_000).toISOString().slice(0, 10);
const cents = (value) => Math.round(Number(value ?? 0) * 100);
const fromCents = (value) => value / 100;

/** Range of UTC days, inclusive. Both ends optional; at most 92 days. `today` is the UTC date (same day rule as /reports/summary). */
export function parseRange(fromValue, toValue, today) {
  const bad = (message) => AppError.badRequest('invalid_report_range', message);
  for (const [name, value] of [['from', fromValue], ['to', toValue]]) {
    if (value !== undefined && value !== null && value !== '' && (typeof value !== 'string' || !isoDate(value))) {
      throw bad(`${name} must be a valid date in YYYY-MM-DD format.`);
    }
  }
  const to = toValue || today;
  const from = fromValue || addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (dayNumber(to) < dayNumber(from) || dayNumber(to) - dayNumber(from) + 1 > MAX_RANGE_DAYS) {
    throw bad(`Choose a date range of at most ${MAX_RANGE_DAYS} days, with the end date on or after the start date.`);
  }
  return { from, to, fromUtc: `${from}T00:00:00.000Z`, untilUtc: `${addDays(to, 1)}T00:00:00.000Z` };
}

/** One list section: the rows kept (at most `limit`), the real count and amount from the database, and whether the list is cut. */
export function section(rows, { count, amount }, limit = LIST_LIMIT) {
  const total = Number(count ?? rows.length);
  return { count: total, amount: fromCents(cents(amount)), truncated: total > limit, items: rows.slice(0, limit) };
}

/** Verified payments of the range grouped by method and by online (made through a payment link) or recorded by staff. */
export function summarizeCollected(rows) {
  const byMethod = rows.map((row) => ({ method: row.Method, online: Boolean(row.Online), count: Number(row.Count), amount: fromCents(cents(row.Amount)) }))
    .sort((a, b) => b.amount - a.amount || a.method.localeCompare(b.method));
  const sum = (list) => ({ count: list.reduce((s, r) => s + r.count, 0), amount: fromCents(list.reduce((s, r) => s + cents(r.amount), 0)) });
  const online = sum(byMethod.filter((r) => r.online));
  const staffRecorded = sum(byMethod.filter((r) => !r.online));
  return { count: online.count + staffRecorded.count, amount: fromCents(cents(online.amount) + cents(staffRecorded.amount)), online, staffRecorded, byMethod };
}

/** Installment plans read against their invoices (the output of loadActivePlans): only the ones with an overdue installment are listed. */
export function summarizeOverdueInstallments(plans, invoiceNumbers, { limit = LIST_LIMIT, planCapReached = false } = {}) {
  const items = [];
  let installments = 0; let amount = 0;
  for (const plan of plans) {
    const late = plan.installments.filter((row) => row.overdue);
    if (!late.length) continue;
    const owed = late.reduce((s, row) => s + cents(row.outstanding), 0);
    installments += late.length; amount += owed;
    items.push({
      invoiceId: plan.invoiceId, invoiceNumber: invoiceNumbers.get(plan.invoiceId) ?? null, overdueCount: late.length,
      overdueAmount: fromCents(owed), oldestDueDate: late.map((row) => row.dueDate).sort()[0], matchesInvoice: plan.matchesInvoice,
    });
  }
  items.sort((a, b) => a.oldestDueDate.localeCompare(b.oldestDueDate) || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
  return { plans: items.length, installments, amount: fromCents(amount), truncated: items.length > limit || planCapReached, items: items.slice(0, limit) };
}

/** Number of findings a person should look at. Open invoices and collected money are not findings. */
export function attentionCount(needsAttention) {
  return needsAttention.needsReviewPayments.count + needsAttention.staleLinks.count + needsAttention.pendingVerification.count
    + needsAttention.paymentsOnVoidedInvoices.count + needsAttention.onlineMismatches.count;
}

export const MISMATCH_LABELS = {
  reversed: 'Reversed in Avzar. The money may still need refunding in Paystack.',
  not_verified: 'The payment is not Verified any more.',
  amount_differs: 'The payment amount differs from the amount paid online.',
  payment_missing: 'The attempt is marked Paid but has no payment.',
};
