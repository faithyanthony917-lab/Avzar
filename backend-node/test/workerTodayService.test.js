import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getMyToday, MAX_TODAY_TASKS } from '../src/auth/workerTodayService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const me = '00000000-0000-4000-8000-000000000040';
const user = { businessId, userId: 'u1', permissions: ['tasks.work'], isOwner: false };
const NOW = new Date('2026-10-26T12:00:00Z');
const at = (time, date = '2026-10-26') => new Date(`${date}T${time}:00Z`);

function fakePool({ membership = [{ Id: me }], zone = 'UTC', tasks = [], leaves = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('FROM "Memberships"')) return { rows: membership };
      if (sql.includes('FROM "Businesses"')) return { rows: [{ TimeZoneId: zone }] };
      if (sql.includes('FROM "ProductionTasks"')) return { rows: tasks };
      if (sql.includes('FROM "WorkerLeaves"')) return { rows: leaves };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}
const taskRow = (id, start, end, over = {}) => ({
  Id: id, OrderId: 'o1', OrderNumber: 'ORD-1', Title: `Task ${id}`, StageName: 'Cutting', Status: 'Scheduled', Priority: 'Normal',
  PlannedStartUtc: start, PlannedEndUtc: end, DeadlineUtc: null, EstimatedMinutes: 60, ...over,
});
const leaveRow = (id, start, end, status = 'Approved') => ({ Id: id, StartsAtUtc: start, EndsAtUtc: end, Reason: 'Appointment', Status: status });

describe('getMyToday', () => {
  it('refuses a user with no active membership', async () => {
    await assert.rejects(getMyToday(fakePool({ membership: [] }), user, NOW), (error) => error.status === 403 && error.code === 'no_active_membership');
  });

  it('asks only for the caller\'s own membership, inside the caller\'s business, for the business-local day', async () => {
    const pool = fakePool({ zone: 'Africa/Lagos' });
    const result = await getMyToday(pool, user, NOW);
    const taskCall = pool.calls.find((call) => call.sql.includes('FROM "ProductionTasks"'));
    assert.equal(taskCall.values[0], businessId);
    assert.equal(taskCall.values[1], me);
    assert.equal(taskCall.values[2].toISOString(), '2026-10-25T23:00:00.000Z'); // Lagos is UTC+1: the day starts at 23:00 UTC
    assert.equal(taskCall.values[3].toISOString(), '2026-10-26T23:00:00.000Z');
    const leaveCall = pool.calls.find((call) => call.sql.includes('FROM "WorkerLeaves"'));
    assert.deepEqual([leaveCall.values[0], leaveCall.values[1]], [businessId, me]);
    assert.equal(result.today, '2026-10-26');
    assert.equal(result.timeZoneId, 'Africa/Lagos');
  });

  it('returns planned tasks in the order the database gave them, as ISO strings', async () => {
    const result = await getMyToday(fakePool({ tasks: [taskRow('a', at('08:00'), at('09:00')), taskRow('b', at('10:00'), at('11:30'), { DeadlineUtc: at('17:00'), EstimatedMinutes: null })] }), user, NOW);
    assert.deepEqual(result.tasks.map((task) => task.taskId), ['a', 'b']);
    assert.equal(result.tasks[0].startUtc, '2026-10-26T08:00:00.000Z');
    assert.equal(result.tasks[1].deadlineUtc, '2026-10-26T17:00:00.000Z');
    assert.equal(result.tasks[1].estimatedMinutes, null);
    assert.equal(result.tasksTruncated, false);
    assert.equal(result.onLeaveToday, false);
  });

  it('cuts the list at the limit and says so', async () => {
    const rows = Array.from({ length: MAX_TODAY_TASKS + 1 }, (_, index) => taskRow(`t${index}`, at('08:00'), at('09:00')));
    const result = await getMyToday(fakePool({ tasks: rows }), user, NOW);
    assert.equal(result.tasks.length, MAX_TODAY_TASKS);
    assert.equal(result.tasksTruncated, true);
  });

  it('is on leave today only for approved leave that overlaps today', async () => {
    const approved = await getMyToday(fakePool({ leaves: [leaveRow('l1', at('00:00'), at('00:00', '2026-10-27'))] }), user, NOW);
    assert.equal(approved.onLeaveToday, true);
    const pending = await getMyToday(fakePool({ leaves: [leaveRow('l2', at('00:00'), at('00:00', '2026-10-27'), 'Pending')] }), user, NOW);
    assert.equal(pending.onLeaveToday, false);
    assert.equal(pending.leave[0].status, 'Pending');
    const later = await getMyToday(fakePool({ leaves: [leaveRow('l3', at('00:00', '2026-10-28'), at('00:00', '2026-10-29'))] }), user, NOW);
    assert.equal(later.onLeaveToday, false);
    assert.equal(later.leave.length, 1);
  });

  it('looks 14 days past today for leave', async () => {
    const pool = fakePool();
    await getMyToday(pool, user, NOW);
    const leaveCall = pool.calls.find((call) => call.sql.includes('FROM "WorkerLeaves"'));
    assert.equal(leaveCall.values[2].toISOString(), '2026-10-26T00:00:00.000Z');
    assert.equal(leaveCall.values[3].toISOString(), '2026-11-10T00:00:00.000Z');
  });
});
