import { AppError } from '../http/errors.js';
import { hasAtMostPlaces, toCents } from '../money.js';

// Step 15b: the pure rules of an installment plan. No database, no clock (the caller passes `today`). Money is whole cents here
// (a JavaScript integer, far below 2^53 for any amount the API accepts) so splits and sums are exact.

export const MIN_INSTALLMENTS = 2;
export const MAX_INSTALLMENTS = 24;
export const INTERVALS = ['weekly', 'monthly'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const cents = (value) => Number(toCents(value));
export const fromCents = (value) => value / 100;

function validationError(field, message) {
  return new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors: { [field]: [message] } });
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const pad = (n) => String(n).padStart(2, '0');
const format = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return format(new Date(Date.UTC(y, m - 1, d + days)));
}

/** The same day of the month `months` later, clamped to the end of a shorter month (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const index = (m - 1) + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(year, month, Math.min(d, lastDay))));
}

/** Splits `totalCents` into `parts` near-equal amounts; the last one absorbs the rounding so the sum is exact. */
export function splitCents(totalCents, parts) {
  const base = Math.floor(totalCents / parts);
  const amounts = Array.from({ length: parts }, () => base);
  amounts[parts - 1] = totalCents - base * (parts - 1);
  return amounts;
}

/** Equal parts, one per week or month starting at `firstDueDate`. Returns [{ sequence, dueDate, amount }] (amount as a number). */
export function buildEqualSchedule({ balance, parts, firstDueDate, interval }) {
  if (!Number.isInteger(parts) || parts < MIN_INSTALLMENTS || parts > MAX_INSTALLMENTS) {
    throw validationError('parts', `Use between ${MIN_INSTALLMENTS} and ${MAX_INSTALLMENTS} parts.`);
  }
  if (!isIsoDate(firstDueDate)) throw validationError('firstDueDate', 'Enter the first due date as YYYY-MM-DD.');
  if (!INTERVALS.includes(interval)) throw validationError('interval', 'Interval must be weekly or monthly.');
  const total = cents(balance);
  if (total < parts) throw validationError('parts', 'The balance is too small to split into that many parts.');
  return splitCents(total, parts).map((amount, index) => ({
    sequence: index + 1,
    dueDate: interval === 'weekly' ? addDays(firstDueDate, 7 * index) : addMonths(firstDueDate, index),
    amount: fromCents(amount),
  }));
}

/** A custom list of { dueDate, amount }: dates real and strictly increasing, amounts above zero with at most 2 places, summing to the balance. */
export function buildCustomSchedule({ balance, items }) {
  if (!Array.isArray(items) || items.length < MIN_INSTALLMENTS || items.length > MAX_INSTALLMENTS) {
    throw validationError('installments', `Use between ${MIN_INSTALLMENTS} and ${MAX_INSTALLMENTS} installments.`);
  }
  let sum = 0;
  let previous = null;
  const schedule = items.map((item, index) => {
    const field = `installments.${index}`;
    if (!isIsoDate(item?.dueDate)) throw validationError(`${field}.dueDate`, 'Enter the due date as YYYY-MM-DD.');
    if (previous !== null && item.dueDate <= previous) throw validationError(`${field}.dueDate`, 'Due dates must be in order, one after another.');
    previous = item.dueDate;
    if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0 || !hasAtMostPlaces(item.amount, 2)) {
      throw validationError(`${field}.amount`, 'Amounts must be above zero and have at most 2 decimal places.');
    }
    sum += cents(item.amount);
    return { sequence: index + 1, dueDate: item.dueDate, amount: item.amount };
  });
  if (sum !== cents(balance)) {
    throw new AppError(400, 'installments_do_not_match_balance',
      `The installments add up to ${fromCents(sum).toFixed(2)} but the balance is ${fromCents(cents(balance)).toFixed(2)}.`);
  }
  return schedule;
}

/** No installment may fall before `today` (the business's local date). */
export function requireNotInPast(schedule, today) {
  if (schedule[0].dueDate < today) throw validationError('firstDueDate', 'The first due date cannot be in the past.');
}

/** True when two schedules have the same dates and amounts in the same order (used to make a repeated create request idempotent). */
export function sameSchedule(a, b) {
  return a.length === b.length && a.every((row, i) => row.dueDate === b[i].dueDate && cents(row.amount) === cents(b[i].amount));
}

/**
 * Reads a schedule against the invoice. `installments` are the stored rows in sequence order. `paidSince` and `creditedSince` are what
 * the invoice has received and been credited since the plan was made (never below zero). A credit shrinks the latest installments first;
 * payments fill the oldest installments first. Money beyond the schedule is ignored here (the invoice's own balance already caps it).
 * Status is calculated, never stored: Paid, PartPaid, Due, or Credited (shrunk to nothing by a credit). `overdue` is true for an
 * unpaid remainder whose own date is before `today`; the invoice's own due date plays no part.
 */
export function allocateSchedule({ installments, paidSince, creditedSince, today }) {
  const effective = installments.map((row) => cents(row.amount));
  let credit = Math.max(0, cents(creditedSince));
  for (let i = effective.length - 1; i >= 0 && credit > 0; i -= 1) {
    const cut = Math.min(effective[i], credit);
    effective[i] -= cut;
    credit -= cut;
  }
  let money = Math.max(0, cents(paidSince));
  const rows = installments.map((row, i) => {
    const applied = Math.min(effective[i], money);
    money -= applied;
    const outstanding = effective[i] - applied;
    let status = 'Due';
    if (effective[i] === 0) status = 'Credited';
    else if (outstanding === 0) status = 'Paid';
    else if (applied > 0) status = 'PartPaid';
    return {
      sequence: row.sequence,
      dueDate: row.dueDate,
      originalAmount: fromCents(cents(row.amount)),
      amount: fromCents(effective[i]),
      paid: fromCents(applied),
      outstanding: fromCents(outstanding),
      status,
      overdue: outstanding > 0 && row.dueDate < today,
    };
  });
  const next = rows.find((row) => cents(row.outstanding) > 0) ?? null;
  return {
    installments: rows,
    outstanding: fromCents(rows.reduce((sum, row) => sum + cents(row.outstanding), 0)),
    next: next && { sequence: next.sequence, dueDate: next.dueDate, amount: next.outstanding, overdue: next.overdue },
    overdueCount: rows.filter((row) => row.overdue).length,
  };
}
