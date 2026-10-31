import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, buildWorkload, dayRangeUtc, dayStatus, intervalsOverlap, isRealDate, localDate, localToUtc, taskFlags, weekdayOf, workerDayCapacity,
} from '../src/auth/workloadReport.js';

// 2026-10-26 is a Monday (weekday 1). Shop: Monday to Saturday 09:00-17:00 (480 minutes), Sunday closed.
const weeklyHours = Array.from({ length: 7 }, (_, dayOfWeek) => (dayOfWeek === 0
  ? { dayOfWeek, isOpen: false, opensAt: null, closesAt: null }
  : { dayOfWeek, isOpen: true, opensAt: '09:00:00', closesAt: '17:00:00' }));
const MON = '2026-10-26';
const at = (date, time) => new Date(`${date}T${time}:00Z`);
const base = { timeZone: 'UTC', weeklyHours, holidays: new Set(), availabilityRows: [], leaves: [] };

describe('date helpers', () => {
  it('knows weekdays, adds days across month ends and validates dates', () => {
    assert.equal(weekdayOf(MON), 1);
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(isRealDate('2026-02-30'), false);
    assert.equal(isRealDate('2026-13-01'), false);
    assert.equal(isRealDate('26-10-26'), false);
    assert.equal(isRealDate(undefined), false);
    assert.equal(isRealDate(MON), true);
  });
  it('reads the business-local date, not the UTC date', () => {
    const instant = new Date('2026-10-26T23:30:00Z');
    assert.equal(localDate(instant, 'UTC'), '2026-10-26');
    assert.equal(localDate(instant, 'Africa/Lagos'), '2026-10-27');
    assert.equal(localDate(instant, 'America/Los_Angeles'), '2026-10-26');
  });
  it('gives 23 and 25 hour days on daylight saving changes', () => {
    const hours = (date, zone) => { const r = dayRangeUtc(date, zone); return (r.endUtc - r.startUtc) / 3_600_000; };
    assert.equal(hours('2026-03-08', 'America/New_York'), 23);
    assert.equal(hours('2026-11-01', 'America/New_York'), 25);
    assert.equal(hours('2026-10-26', 'America/New_York'), 24);
    assert.equal(hours('2026-10-26', 'Africa/Lagos'), 24);
  });
  it('moves a local time inside a spring-forward gap on instead of throwing', () => {
    assert.equal(localToUtc('2026-03-08', '02:30', 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z');
  });
  it('tests interval overlap with touching ends not overlapping', () => {
    assert.equal(intervalsOverlap(at(MON, '09:00'), at(MON, '10:00'), at(MON, '10:00'), at(MON, '11:00')), false);
    assert.equal(intervalsOverlap(at(MON, '09:00'), at(MON, '10:01'), at(MON, '10:00'), at(MON, '11:00')), true);
  });
});

describe('workerDayCapacity', () => {
  it('a worker with no availability rows gets the shop open minutes', () => {
    assert.deepEqual(workerDayCapacity({ ...base, date: MON }), { capacityMinutes: 480, leaveMinutes: 0, reason: null });
  });
  it('a closed shop day and a holiday have no capacity', () => {
    assert.equal(workerDayCapacity({ ...base, date: '2026-10-25' }).reason, 'closed');
    const holiday = workerDayCapacity({ ...base, date: MON, holidays: new Set([MON]) });
    assert.deepEqual([holiday.capacityMinutes, holiday.reason], [0, 'holiday']);
  });
  it('a configured worker is limited by the smaller of capacity and the window', () => {
    const row = (capacityMinutes, opensAt, closesAt) => [{ dayOfWeek: 1, isAvailable: true, opensAt, closesAt, capacityMinutes }];
    assert.equal(workerDayCapacity({ ...base, date: MON, availabilityRows: row(300, '09:00', '17:00') }).capacityMinutes, 300);
    assert.equal(workerDayCapacity({ ...base, date: MON, availabilityRows: row(900, '09:00', '17:00') }).capacityMinutes, 480);
    // worker window 13:00-17:00 intersects the shop hours: 240 minutes
    assert.equal(workerDayCapacity({ ...base, date: MON, availabilityRows: row(480, '13:00', '17:00') }).capacityMinutes, 240);
    // a worker window outside the shop hours leaves nothing
    assert.deepEqual(workerDayCapacity({ ...base, date: MON, availabilityRows: row(120, '18:00', '20:00') }),
      { capacityMinutes: 0, leaveMinutes: 0, reason: 'unavailable' });
  });
  it('a weekday the worker has no row for, or marked unavailable, has no capacity', () => {
    const onlyTuesday = [{ dayOfWeek: 2, isAvailable: true, opensAt: '09:00', closesAt: '17:00', capacityMinutes: 480 }];
    assert.equal(workerDayCapacity({ ...base, date: MON, availabilityRows: onlyTuesday }).reason, 'unavailable');
    const off = [{ dayOfWeek: 1, isAvailable: false, opensAt: null, closesAt: null, capacityMinutes: 0 }];
    assert.equal(workerDayCapacity({ ...base, date: MON, availabilityRows: off }).capacityMinutes, 0);
  });
  it('approved leave takes minutes from the window, and overlapping leave is not counted twice', () => {
    const leaves = [{ startUtc: at(MON, '10:00'), endUtc: at(MON, '12:00') }, { startUtc: at(MON, '11:00'), endUtc: at(MON, '13:00') }];
    assert.deepEqual(workerDayCapacity({ ...base, date: MON, leaves }), { capacityMinutes: 300, leaveMinutes: 180, reason: null });
  });
  it('leave outside the window changes nothing; leave over the whole day gives reason leave', () => {
    assert.equal(workerDayCapacity({ ...base, date: MON, leaves: [{ startUtc: at(MON, '06:00'), endUtc: at(MON, '08:00') }] }).capacityMinutes, 480);
    const full = workerDayCapacity({ ...base, date: MON, leaves: [{ startUtc: at('2026-10-25', '00:00'), endUtc: at('2026-10-28', '00:00') }] });
    assert.deepEqual([full.capacityMinutes, full.leaveMinutes, full.reason], [0, 480, 'leave']);
  });
  it('uses the business time zone for the window', () => {
    // Lagos is UTC+1: 09:00-17:00 local is 08:00-16:00 UTC, so leave 08:00-10:00 UTC takes 120 minutes.
    const result = workerDayCapacity({ ...base, timeZone: 'Africa/Lagos', date: MON, leaves: [{ startUtc: at(MON, '08:00'), endUtc: at(MON, '10:00') }] });
    assert.equal(result.leaveMinutes, 120);
    assert.equal(result.capacityMinutes, 360);
  });
});

describe('dayStatus', () => {
  it('classifies off, ok, near and over', () => {
    assert.equal(dayStatus(0, 0), 'off');
    assert.equal(dayStatus(0, 30), 'over');
    assert.equal(dayStatus(480, 100), 'ok');
    assert.equal(dayStatus(480, 431), 'ok');
    assert.equal(dayStatus(480, 432), 'near');
    assert.equal(dayStatus(480, 480), 'near');
    assert.equal(dayStatus(480, 481), 'over');
  });
});

describe('buildWorkload', () => {
  const workers = [{ membershipId: 'w1', displayName: 'Ada' }, { membershipId: 'w2', displayName: 'Bayo' }];
  const task = (id, membershipId, start, end, status = 'Scheduled') => ({ id, membershipId, status, plannedStartUtc: at(...start), plannedEndUtc: at(...end) });
  const run = (extra = {}) => buildWorkload({ fromDate: MON, days: 3, timeZone: 'UTC', weeklyHours, workers, ...extra });

  it('sums planned minutes per worker and day and reports over, near and ok', () => {
    const report = run({
      availability: [{ membershipId: 'w1', dayOfWeek: 1, isAvailable: true, opensAt: '09:00', closesAt: '17:00', capacityMinutes: 120 }],
      tasks: [task('a', 'w1', [MON, '09:00'], [MON, '10:00']), task('b', 'w1', [MON, '10:00'], [MON, '11:30']), task('c', 'w2', [MON, '09:00'], [MON, '16:20'])],
    });
    const [ada, bayo] = report.workers;
    assert.deepEqual([ada.days[0].plannedMinutes, ada.days[0].capacityMinutes, ada.days[0].status], [150, 120, 'over']);
    assert.equal(ada.overDays, 1);
    assert.deepEqual([bayo.days[0].plannedMinutes, bayo.days[0].capacityMinutes, bayo.days[0].status], [440, 480, 'near']);
    assert.equal(bayo.days[0].utilization, 0.917);
    assert.equal(report.days.length, 3);
    assert.equal(report.totalPlannedMinutes, 590);
  });
  it('ignores tasks that do not hold planned time and other workers\' tasks', () => {
    const report = run({ tasks: [task('a', 'w1', [MON, '09:00'], [MON, '10:00'], 'Completed'), task('b', 'w1', [MON, '09:00'], [MON, '10:00'], 'Pending'), task('c', 'w2', [MON, '09:00'], [MON, '10:00'])] });
    assert.equal(report.workers[0].totalPlannedMinutes, 0);
    assert.equal(report.workers[1].totalPlannedMinutes, 60);
  });
  it('splits a task that crosses local midnight between the two days', () => {
    const report = run({ tasks: [task('a', 'w1', [MON, '23:00'], ['2026-10-27', '01:00'])] });
    assert.deepEqual([report.workers[0].days[0].plannedMinutes, report.workers[0].days[1].plannedMinutes], [60, 60]);
  });
  it('a closed day shows off, or over if work is planned on it', () => {
    const report = buildWorkload({ fromDate: '2026-10-25', days: 2, timeZone: 'UTC', weeklyHours, workers: [workers[0]], tasks: [task('a', 'w1', ['2026-10-25', '10:00'], ['2026-10-25', '11:00'])] });
    assert.deepEqual([report.workers[0].days[0].status, report.workers[0].days[0].reason], ['over', 'closed']);
    assert.equal(report.workers[0].days[1].status, 'ok');
  });
  it('approved leave lowers capacity and can turn a planned day over', () => {
    const report = run({
      leaves: [{ membershipId: 'w1', startUtc: at(MON, '09:00'), endUtc: at(MON, '15:00') }],
      tasks: [task('a', 'w1', [MON, '15:00'], [MON, '17:00'])],
    });
    assert.deepEqual([report.workers[0].days[0].capacityMinutes, report.workers[0].days[0].status], [120, 'near']);
    assert.equal(report.workers[1].days[0].capacityMinutes, 480);
  });
  it('counts the 23-hour daylight-saving day by its real window', () => {
    const report = buildWorkload({ fromDate: '2026-03-08', days: 1, timeZone: 'America/New_York',
      weeklyHours: weeklyHours.map((d) => (d.dayOfWeek === 0 ? { ...d, isOpen: true, opensAt: '00:00:00', closesAt: '23:59:00' } : d)),
      workers: [workers[0]] });
    assert.equal(report.workers[0].days[0].capacityMinutes, 23 * 60 + 59 - 60);
  });
  it('rejects a bad start date and a bad day count', () => {
    assert.throws(() => run({ fromDate: '2026-02-30' }), RangeError);
    assert.throws(() => run({ days: 0 }), RangeError);
    assert.throws(() => run({ days: 32 }), RangeError);
    assert.throws(() => run({ days: 2.5 }), RangeError);
  });
});

describe('taskFlags', () => {
  const now = at(MON, '12:00');
  const leavesByWorker = new Map([['w1', [{ startUtc: at(MON, '14:00'), endUtc: at(MON, '16:00') }]]]);
  const flags = (task) => taskFlags({ status: 'Scheduled', membershipId: 'w1', estimatedMinutes: 60, ...task }, { now, leavesByWorker });

  it('flags nothing on a healthy task', () => {
    assert.deepEqual(Object.values(flags({ deadlineUtc: at('2026-10-30', '12:00'), plannedStartUtc: at(MON, '09:00'), plannedEndUtc: at(MON, '10:00') })).filter(Boolean), []);
  });
  it('flags overdue open tasks but not completed ones', () => {
    assert.equal(flags({ deadlineUtc: at(MON, '11:00') }).overdue, true);
    assert.equal(flags({ deadlineUtc: at(MON, '11:00'), status: 'Completed' }).overdue, false);
  });
  it('flags a plan that ends after the deadline', () => {
    assert.equal(flags({ deadlineUtc: at(MON, '12:30'), plannedStartUtc: at(MON, '12:00'), plannedEndUtc: at(MON, '13:00') }).lateAgainstDeadline, true);
    assert.equal(flags({ deadlineUtc: at(MON, '13:00'), plannedStartUtc: at(MON, '12:00'), plannedEndUtc: at(MON, '13:00') }).lateAgainstDeadline, false);
  });
  it('flags blocked, unassigned and missing estimates', () => {
    assert.equal(flags({ status: 'Blocked' }).blocked, true);
    assert.equal(flags({ membershipId: null }).unassigned, true);
    assert.equal(flags({ estimatedMinutes: null }).noEstimate, true);
    assert.equal(flags({ status: 'Cancelled', membershipId: null, estimatedMinutes: null }).unassigned, false);
  });
  it('flags a planned slot that overlaps approved leave of the assignee only', () => {
    assert.equal(flags({ plannedStartUtc: at(MON, '15:00'), plannedEndUtc: at(MON, '17:00') }).insideLeave, true);
    assert.equal(flags({ plannedStartUtc: at(MON, '16:00'), plannedEndUtc: at(MON, '17:00') }).insideLeave, false);
    assert.equal(flags({ membershipId: 'w2', plannedStartUtc: at(MON, '15:00'), plannedEndUtc: at(MON, '17:00') }).insideLeave, false);
    assert.equal(flags({}).insideLeave, false);
  });
});
