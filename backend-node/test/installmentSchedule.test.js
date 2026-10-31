import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addMonths, allocateSchedule, buildCustomSchedule, buildEqualSchedule, isIsoDate, requireNotInPast, sameSchedule, splitCents,
} from '../src/auth/installmentSchedule.js';

const amounts = (schedule) => schedule.map((row) => row.amount);
const rows = (list) => list.map(([dueDate, amount], i) => ({ sequence: i + 1, dueDate, amount }));

describe('splitting', () => {
  it('splits evenly when the balance divides', () => {
    assert.deepEqual(amounts(buildEqualSchedule({ balance: 300, parts: 3, firstDueDate: '2026-11-01', interval: 'monthly' })), [100, 100, 100]);
  });
  it('makes the last part absorb the rounding, and the parts always add up exactly', () => {
    const schedule = buildEqualSchedule({ balance: 100, parts: 3, firstDueDate: '2026-11-01', interval: 'weekly' });
    assert.deepEqual(amounts(schedule), [33.33, 33.33, 33.34]);
    assert.equal(splitCents(10001, 7).reduce((a, b) => a + b, 0), 10001);
    for (const balance of [0.07, 19.99, 1234567.89]) {
      const parts = balance < 1 ? 2 : 7;
      const total = buildEqualSchedule({ balance, parts, firstDueDate: '2026-01-31', interval: 'monthly' }).reduce((s, r) => s + Math.round(r.amount * 100), 0);
      assert.equal(total, Math.round(balance * 100));
    }
  });
  it('refuses a balance too small to split, and a bad part count, date or interval', () => {
    assert.throws(() => buildEqualSchedule({ balance: 0.01, parts: 2, firstDueDate: '2026-11-01', interval: 'weekly' }), { code: 'validation_failed' });
    assert.throws(() => buildEqualSchedule({ balance: 100, parts: 1, firstDueDate: '2026-11-01', interval: 'weekly' }), { code: 'validation_failed' });
    assert.throws(() => buildEqualSchedule({ balance: 100, parts: 25, firstDueDate: '2026-11-01', interval: 'weekly' }), { code: 'validation_failed' });
    assert.throws(() => buildEqualSchedule({ balance: 100, parts: 2, firstDueDate: '2026-02-30', interval: 'weekly' }), { code: 'validation_failed' });
    assert.throws(() => buildEqualSchedule({ balance: 100, parts: 2, firstDueDate: '2026-11-01', interval: 'daily' }), { code: 'validation_failed' });
  });
});

describe('dates', () => {
  it('steps weekly by seven days and monthly on the same day, clamped to a short month', () => {
    assert.equal(addDays('2026-12-28', 7), '2027-01-04');
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonths('2026-11-15', 2), '2027-01-15');
    const dates = buildEqualSchedule({ balance: 90, parts: 3, firstDueDate: '2026-01-31', interval: 'monthly' }).map((r) => r.dueDate);
    assert.deepEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31']);
  });
  it('checks real calendar dates', () => {
    assert.equal(isIsoDate('2026-02-29'), false);
    assert.equal(isIsoDate('2028-02-29'), true);
    assert.equal(isIsoDate('2026-1-1'), false);
    assert.equal(isIsoDate(20261101), false);
  });
  it('refuses a first due date before today but accepts today', () => {
    const schedule = rows([['2026-10-26', 50], ['2026-11-26', 50]]);
    assert.throws(() => requireNotInPast(schedule, '2026-10-27'), { code: 'validation_failed' });
    assert.doesNotThrow(() => requireNotInPast(rows([['2026-10-27', 50], ['2026-11-27', 50]]), '2026-10-27'));
  });
});

describe('custom lists', () => {
  const items = [{ dueDate: '2026-11-01', amount: 70 }, { dueDate: '2026-12-01', amount: 30 }];
  it('accepts a list that sums to the balance', () => {
    assert.deepEqual(amounts(buildCustomSchedule({ balance: 100, items })), [70, 30]);
  });
  it('refuses a wrong sum, with the code the screen can show', () => {
    assert.throws(() => buildCustomSchedule({ balance: 120, items }), { code: 'installments_do_not_match_balance' });
  });
  it('refuses repeated or out-of-order dates, zero, negative and over-precise amounts, and a bad count', () => {
    assert.throws(() => buildCustomSchedule({ balance: 100, items: [items[0], { dueDate: '2026-11-01', amount: 30 }] }), { code: 'validation_failed' });
    assert.throws(() => buildCustomSchedule({ balance: 100, items: [items[1], items[0]] }), { code: 'validation_failed' });
    assert.throws(() => buildCustomSchedule({ balance: 100, items: [{ dueDate: '2026-11-01', amount: 100 }, { dueDate: '2026-12-01', amount: 0 }] }), { code: 'validation_failed' });
    assert.throws(() => buildCustomSchedule({ balance: 100, items: [{ dueDate: '2026-11-01', amount: 100.005 }, { dueDate: '2026-12-01', amount: -0.005 }] }), { code: 'validation_failed' });
    assert.throws(() => buildCustomSchedule({ balance: 100, items: [items[0]] }), { code: 'validation_failed' });
  });
  it('recognises the same schedule for an idempotent repeat', () => {
    assert.equal(sameSchedule(buildCustomSchedule({ balance: 100, items }), rows([['2026-11-01', 70], ['2026-12-01', 30]])), true);
    assert.equal(sameSchedule(rows([['2026-11-01', 70], ['2026-12-01', 30]]), rows([['2026-11-01', 60], ['2026-12-01', 40]])), false);
  });
});

describe('reading a schedule against the invoice', () => {
  const plan = rows([['2026-11-01', 100], ['2026-12-01', 100], ['2027-01-01', 100]]);
  const read = (overrides) => allocateSchedule({ installments: plan, paidSince: 0, creditedSince: 0, today: '2026-10-27', ...overrides });

  it('starts with everything due and none overdue', () => {
    const result = read();
    assert.deepEqual(result.installments.map((r) => r.status), ['Due', 'Due', 'Due']);
    assert.equal(result.outstanding, 300);
    assert.deepEqual(result.next, { sequence: 1, dueDate: '2026-11-01', amount: 100, overdue: false });
  });
  it('fills the oldest installment first and part-pays the next', () => {
    const result = read({ paidSince: 150 });
    assert.deepEqual(result.installments.map((r) => [r.status, r.paid, r.outstanding]), [['Paid', 100, 0], ['PartPaid', 50, 50], ['Due', 0, 100]]);
    assert.deepEqual(result.next, { sequence: 2, dueDate: '2026-12-01', amount: 50, overdue: false });
    assert.equal(result.outstanding, 150);
  });
  it('counts an installment overdue on its own date, and a part-paid one stays overdue for what is left', () => {
    const result = read({ today: '2026-12-02', paidSince: 150 });
    assert.deepEqual(result.installments.map((r) => r.overdue), [false, true, false]);
    assert.equal(result.overdueCount, 1);
    assert.equal(result.installments[1].status, 'PartPaid');
    assert.equal(read({ today: '2026-11-01' }).overdueCount, 0);
    assert.equal(read({ today: '2026-11-02' }).overdueCount, 1);
  });
  it('shrinks the latest installments first when a credit is applied', () => {
    const result = read({ creditedSince: 130 });
    assert.deepEqual(result.installments.map((r) => [r.amount, r.status]), [[100, 'Due'], [70, 'Due'], [0, 'Credited']]);
    assert.equal(result.outstanding, 170);
  });
  it('reads payments and credits together', () => {
    const result = read({ paidSince: 100, creditedSince: 100 });
    assert.deepEqual(result.installments.map((r) => r.status), ['Paid', 'Due', 'Credited']);
    assert.equal(result.next.sequence, 2);
  });
  it('finishes when everything is paid, ignoring money beyond the schedule', () => {
    const result = read({ paidSince: 500 });
    assert.deepEqual(result.installments.map((r) => r.status), ['Paid', 'Paid', 'Paid']);
    assert.equal(result.outstanding, 0);
    assert.equal(result.next, null);
    assert.equal(result.overdueCount, 0);
  });
  it('treats a negative amount since creation (a reversed older payment) as nothing', () => {
    assert.equal(read({ paidSince: -50 }).outstanding, 300);
  });
  it('keeps cents exact with fractional installments', () => {
    const fractional = rows([['2026-11-01', 33.33], ['2026-12-01', 33.33], ['2027-01-01', 33.34]]);
    const result = allocateSchedule({ installments: fractional, paidSince: 66.67, creditedSince: 0, today: '2026-10-27' });
    assert.deepEqual(result.installments.map((r) => [r.status, r.outstanding]), [['Paid', 0], ['Paid', 0], ['PartPaid', 33.33]]);
  });
});
