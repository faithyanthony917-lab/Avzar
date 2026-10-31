import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLeaveConflicts, getProductionCalendar, getProductionOverview, getWorkload,
} from '../src/auth/productionViewService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const w1 = '00000000-0000-4000-8000-000000000040';
const locationA = '00000000-0000-4000-8000-0000000000a1';
const user = { businessId, userId: 'u1', permissions: ['tasks.view'], isOwner: false };
const NOW = new Date('2026-10-26T12:00:00Z'); // a Monday, 12:00 UTC
const at = (time, date = '2026-10-26') => new Date(`${date}T${time}:00Z`);

const hours = Array.from({ length: 7 }, (_, dayOfWeek) => (dayOfWeek === 0
  ? { DayOfWeek: 0, IsOpen: false, OpensAt: null, ClosesAt: null }
  : { DayOfWeek: dayOfWeek, IsOpen: true, OpensAt: '09:00:00', ClosesAt: '17:00:00' }));

/** A fake pool: answers by recognising the SQL, and records every call. `data` overrides the default answers. */
function fakePool(data = {}) {
  const calls = [];
  const answers = {
    plan: [{ Value: 'true' }],
    attention: [{ OpenTasks: 10, Overdue: 1, Blocked: 2, Unassigned: 3, NoEstimate: 2, LateAgainstDeadline: 1, InsideLeave: 1 }],
    taskRows: [], leaves: [], workers: [], availability: [], loadTasks: [], unplanned: [], conflicts: [], holidays: [],
    ...data,
  };
  return {
    calls,
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('FROM "Plans" p')) return { rows: answers.plan };
      if (sql.includes('FROM "Businesses"')) return { rows: [{ TimeZoneId: 'UTC' }] };
      if (sql.includes('WITH leaves AS')) return { rows: answers.conflicts };
      if (sql.includes('"OpenTasks"')) return { rows: answers.attention };
      if (sql.includes('AS "StartUtc"')) return { rows: answers.leaves };
      if (sql.includes('ORDER BY m."DisplayName"')) return { rows: answers.workers };
      if (sql.includes('FROM "BusinessHours"')) return { rows: hours };
      if (sql.includes('FROM "BusinessHolidays"')) return { rows: answers.holidays };
      if (sql.includes('"CapacityMinutes", "IsAvailable"')) return { rows: answers.availability };
      if (sql.includes('AS "Minutes"')) return { rows: answers.unplanned };
      if (sql.includes('t."AssignedMembershipId" AS "MembershipId", t."Status"')) return { rows: answers.loadTasks };
      if (sql.includes('AS "WorkerName"')) return { rows: answers.taskRows };
      throw new Error(`Unexpected SQL in test: ${sql.slice(0, 120)}`);
    },
  };
}

const taskRow = (extra = {}) => ({
  Id: 't1', OrderId: 'o1', OrderNumber: 'ORD-1', Title: 'Cut', StageName: 'Cutting', Status: 'Scheduled', Priority: 'Normal',
  AssignedMembershipId: w1, WorkerName: 'Ada', PlannedStartUtc: at('14:00'), PlannedEndUtc: at('15:00'),
  DeadlineUtc: at('14:30'), EstimatedMinutes: 60, ...extra,
});

const rejects = (promise, status, code) => assert.rejects(promise, (error) => error.status === status && error.code === code);

describe('production view service: overview', () => {
  it('returns attention counts and groups today\'s tasks by worker, with flags', async () => {
    const pool = fakePool({
      taskRows: [taskRow(), taskRow({ Id: 't2', AssignedMembershipId: null, WorkerName: null, DeadlineUtc: null })],
      leaves: [{ MembershipId: w1, StartUtc: at('14:30'), EndUtc: at('16:00') }],
    });
    const result = await getProductionOverview(pool, user, [locationA], NOW);
    assert.equal(result.today, '2026-10-26');
    assert.equal(result.timeZoneId, 'UTC');
    assert.equal(result.scopedToLocations, true);
    assert.deepEqual(result.attention, { openTasks: 10, overdue: 1, blocked: 2, unassigned: 3, noEstimate: 2, lateAgainstDeadline: 1, insideLeave: 1 });
    assert.equal(result.todayByWorker.length, 2);
    const ada = result.todayByWorker.find((group) => group.membershipId === w1);
    assert.equal(ada.displayName, 'Ada');
    assert.equal(ada.tasks[0].startUtc, '2026-10-26T14:00:00.000Z');
    assert.equal(ada.tasks[0].flags.insideLeave, true);
    assert.equal(ada.tasks[0].flags.lateAgainstDeadline, true);
    assert.equal(ada.tasks[0].flags.overdue, false);
    const unassigned = result.todayByWorker.find((group) => group.membershipId === null);
    assert.equal(unassigned.tasks[0].flags.unassigned, true);
  });
  it('passes the caller\'s locations and only production-active order statuses to the database', async () => {
    const pool = fakePool();
    await getProductionOverview(pool, user, [locationA], NOW);
    const attention = pool.calls.find((call) => call.sql.includes('"OpenTasks"'));
    assert.deepEqual(attention.values[1], ['Confirmed', 'InProduction']);
    assert.deepEqual(attention.values[2], [locationA]);
    assert.ok(attention.sql.includes('o."LocationId" = ANY($3::uuid[])'));
    const list = pool.calls.find((call) => call.sql.includes('AS "WorkerName"'));
    assert.deepEqual(list.values[4], [locationA]);
    assert.ok(list.sql.includes('"BusinessId" = $1'));
    assert.equal(list.values[0], businessId);
  });
  it('does not touch the plan tables (it is not plan-gated) and says unscoped for a user with every location', async () => {
    const pool = fakePool({ plan: [{ Value: 'false' }] });
    const result = await getProductionOverview(pool, user, null, NOW);
    assert.equal(result.scopedToLocations, false);
    assert.equal(pool.calls.some((call) => call.sql.includes('FROM "Plans" p')), false);
  });
  it('marks a truncated list', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => taskRow({ Id: `t${index}` }));
    const result = await getProductionOverview(fakePool({ taskRows: rows }), user, null, NOW);
    assert.equal(result.todayTruncated, true);
    assert.equal(result.todayByWorker[0].tasks.length, 500);
  });
});

describe('production view service: workload', () => {
  it('is refused on a plan without the shop-wide schedule, before any production data is read', async () => {
    const pool = fakePool({ plan: [{ Value: 'false' }] });
    await rejects(getWorkload(pool, user, null, {}, NOW), 403, 'feature_not_in_plan');
    assert.equal(pool.calls.some((call) => call.sql.includes('FROM "ProductionTasks"')), false);
  });
  it('rejects a bad start date and a bad day count', async () => {
    for (const query of [{ from: '2026-02-30' }, { from: 'tomorrow' }, { from: ['2026-10-26'] }, { days: '0' }, { days: '32' }, { days: 'abc' }, { days: '2.5' }, { days: ['3'] }]) {
      await rejects(getWorkload(fakePool(), user, null, query, NOW), 400, 'invalid_range');
    }
  });
  it('turns rows into per-day capacity, planned minutes, status and a forecast', async () => {
    const pool = fakePool({
      workers: [{ Id: w1, DisplayName: 'Ada' }],
      availability: [{ MembershipId: w1, DayOfWeek: 1, OpensAt: '09:00:00', ClosesAt: '17:00:00', CapacityMinutes: 120, IsAvailable: true }],
      loadTasks: [{ MembershipId: w1, Status: 'Scheduled', PlannedStartUtc: at('09:00'), PlannedEndUtc: at('11:30') }],
      unplanned: [{ MembershipId: w1, Tasks: 1, Minutes: 60 }],
    });
    const result = await getWorkload(pool, user, null, { days: '2' }, NOW);
    assert.equal(result.fromDate, '2026-10-26');
    assert.deepEqual(result.days, ['2026-10-26', '2026-10-27']);
    const ada = result.workers[0];
    assert.deepEqual([ada.days[0].capacityMinutes, ada.days[0].plannedMinutes, ada.days[0].status], [120, 150, 'over']);
    assert.equal(ada.days[1].reason, 'unavailable');
    assert.deepEqual([ada.unplannedTasks, ada.unplannedMinutes, ada.overDays], [1, 60, 1]);
    assert.deepEqual(result.forecast, {
      totalCapacityMinutes: 120, totalPlannedMinutes: 150, unplannedMinutes: 60, shortfallMinutes: 90,
      overDays: 1, unassignedTasks: 3, tasksWithoutEstimate: 2,
    });
  });
  it('lists no workers and reads no worker data when nobody is relevant', async () => {
    const pool = fakePool();
    const result = await getWorkload(pool, user, [locationA], {}, NOW);
    assert.deepEqual(result.workers, []);
    assert.equal(result.days.length, 14);
    assert.equal(pool.calls.some((call) => call.sql.includes('"CapacityMinutes", "IsAvailable"')), false);
    const workers = pool.calls.find((call) => call.sql.includes('ORDER BY m."DisplayName"'));
    assert.deepEqual(workers.values, [businessId, [locationA]]);
  });
});

describe('production view service: calendar', () => {
  it('is refused on a plan without the shop-wide schedule', async () => {
    await rejects(getProductionCalendar(fakePool({ plan: [{ Value: 'false' }] }), user, null, {}, NOW), 403, 'feature_not_in_plan');
  });
  it('validates range and worker filter', async () => {
    await rejects(getProductionCalendar(fakePool(), user, null, { from: '2026-13-01' }, NOW), 400, 'invalid_range');
    await rejects(getProductionCalendar(fakePool(), user, null, { days: '40' }, NOW), 400, 'invalid_range');
    await rejects(getProductionCalendar(fakePool(), user, null, { membershipId: 'not-a-uuid' }, NOW), 400, 'invalid_membership');
    await rejects(getProductionCalendar(fakePool(), user, null, { membershipId: ['a', 'b'] }, NOW), 400, 'invalid_membership');
  });
  it('returns slots with flags, passes the worker filter and the locations, and marks truncation', async () => {
    const pool = fakePool({ taskRows: Array.from({ length: 501 }, (_, i) => taskRow({ Id: `t${i}`, Status: i === 0 ? 'Blocked' : 'Scheduled' })) });
    const result = await getProductionCalendar(pool, user, [locationA], { from: '2026-10-26', days: '7', membershipId: w1 }, NOW);
    assert.equal(result.truncated, true);
    assert.equal(result.slots.length, 500);
    assert.equal(result.slots[0].flags.blocked, true);
    assert.equal(result.slots[1].flags.blocked, false);
    const call = pool.calls.find((c) => c.sql.includes('AS "WorkerName"'));
    assert.equal(call.values[4], w1);
    assert.deepEqual(call.values[5], [locationA]);
    assert.equal(new Date(call.values[3]).toISOString(), '2026-11-02T00:00:00.000Z');
  });
});

describe('production view service: leave conflicts', () => {
  const leaveRow = (extra = {}) => ({
    LeaveId: 'l1', MembershipId: w1, WorkerName: 'Ada', StartsAtUtc: at('00:00', '2026-10-27'), EndsAtUtc: at('00:00', '2026-10-29'),
    Reason: 'Family event', Status: 'Approved', TaskId: null, ...extra,
  });
  it('groups the tasks under each leave, keeps leave with no conflict, and passes the locations', async () => {
    const pool = fakePool({
      conflicts: [
        leaveRow({ TaskId: 't1', Title: 'Cut', OrderNumber: 'ORD-1', TaskStatus: 'Scheduled', PlannedStartUtc: at('10:00', '2026-10-27'), PlannedEndUtc: at('11:00', '2026-10-27') }),
        leaveRow({ TaskId: 't2', Title: 'Sew', OrderNumber: 'ORD-1', TaskStatus: 'Scheduled', PlannedStartUtc: at('12:00', '2026-10-27'), PlannedEndUtc: at('13:00', '2026-10-27') }),
        leaveRow({ LeaveId: 'l2', Status: 'Pending' }),
      ],
    });
    const result = await getLeaveConflicts(pool, user, [locationA], NOW);
    assert.equal(result.scopedToLocations, true);
    assert.equal(result.leaves.length, 2);
    assert.deepEqual([result.leaves[0].affectedTaskCount, result.leaves[0].affectedTasks.map((t) => t.taskId)], [2, ['t1', 't2']]);
    assert.equal(result.leaves[0].affectedTasks[0].startUtc, '2026-10-27T10:00:00.000Z');
    assert.deepEqual([result.leaves[1].status, result.leaves[1].affectedTaskCount, result.leaves[1].affectedTasks], ['Pending', 0, []]);
    const call = pool.calls.find((c) => c.sql.includes('WITH leaves AS'));
    assert.deepEqual(call.values, [businessId, NOW, [locationA]]);
    assert.equal(pool.calls.some((c) => c.sql.includes('FROM "Plans" p')), false);
  });
  it('caps the tasks listed under one leave at 50 and says so', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => leaveRow({ TaskId: `t${i}`, Title: 'x', OrderNumber: 'ORD-1', TaskStatus: 'Scheduled', PlannedStartUtc: at('10:00', '2026-10-27'), PlannedEndUtc: at('11:00', '2026-10-27') }));
    const result = await getLeaveConflicts(fakePool({ conflicts: rows }), user, null, NOW);
    assert.equal(result.leaves[0].affectedTasks.length, 50);
    assert.equal(result.leaves[0].affectedTasksTruncated, true);
  });
});
