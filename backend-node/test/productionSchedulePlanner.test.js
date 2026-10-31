import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planProductionSchedule } from '../src/auth/productionSchedulePlanner.js';

const workerId = 'worker-1';
const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  isOpen: dayOfWeek >= 1 && dayOfWeek <= 5,
  opensAt: dayOfWeek >= 1 && dayOfWeek <= 5 ? '09:00:00' : null,
  closesAt: dayOfWeek >= 1 && dayOfWeek <= 5 ? '17:00:00' : null,
}));

describe('production schedule planner', () => {
  it('plans by priority, avoids existing reservations, and schedules dependencies in order', () => {
    const plan = planProductionSchedule({
      candidates: [
        { id: 'dependent', assignedMembershipId: workerId, estimatedMinutes: 60, priorityRank: 0, stageOrder: 2, dependsOnTaskIds: ['first'] },
        { id: 'first', assignedMembershipId: workerId, estimatedMinutes: 60, priorityRank: 3, stageOrder: 1, dependsOnTaskIds: [] },
        { id: 'urgent', assignedMembershipId: workerId, estimatedMinutes: 60, priorityRank: 0, stageOrder: 0, dependsOnTaskIds: [] },
      ],
      reservations: [{ membershipId: workerId, startUtc: '2026-06-08T09:00:00Z', endUtc: '2026-06-08T10:00:00Z' }],
      weeklyHours: hours,
      holidays: [],
      timeZone: 'UTC',
      startUtc: new Date('2026-06-08T09:00:00Z'),
      horizonDays: 3,
    });

    assert.deepEqual(plan.scheduled.map(({ taskId, startUtc }) => [taskId, startUtc.toISOString()]), [
      ['urgent', '2026-06-08T10:00:00.000Z'],
      ['first', '2026-06-08T11:00:00.000Z'],
      ['dependent', '2026-06-08T12:00:00.000Z'],
    ]);
    assert.deepEqual(plan.unscheduled, []);
  });

  it('reports missing assignments and propagates unscheduled prerequisites', () => {
    const plan = planProductionSchedule({
      candidates: [
        { id: 'unassigned', assignedMembershipId: null, estimatedMinutes: 30, priorityRank: 1, stageOrder: 1, dependsOnTaskIds: [] },
        { id: 'dependent', assignedMembershipId: workerId, estimatedMinutes: 30, priorityRank: 1, stageOrder: 2, dependsOnTaskIds: ['unassigned'] },
      ],
      reservations: [],
      weeklyHours: hours,
      holidays: [],
      timeZone: 'UTC',
      startUtc: new Date('2026-06-08T09:00:00Z'),
      horizonDays: 2,
    });

    assert.deepEqual(plan.unscheduled, [
      { taskId: 'unassigned', reason: 'Worker assignment is required.' },
      { taskId: 'dependent', reason: 'A prerequisite could not be scheduled.' },
    ]);
  });

  it('respects worker availability, capacity, leave, and shop holidays', () => {
    const plan = planProductionSchedule({
      candidates: [
        { id: 'only-task', assignedMembershipId: workerId, estimatedMinutes: 120, priorityRank: 1, stageOrder: 1, dependsOnTaskIds: [] },
      ],
      reservations: [],
      weeklyHours: hours,
      holidays: ['2026-06-08'],
      timeZone: 'UTC',
      startUtc: new Date('2026-06-08T09:00:00Z'),
      horizonDays: 2,
      workerAvailability: [{
        membershipId: workerId, dayOfWeek: 2, isAvailable: true,
        opensAt: '10:00:00', closesAt: '14:00:00', capacityMinutes: 60,
      }],
      workerLeave: [{ membershipId: workerId, startUtc: '2026-06-09T10:00:00Z', endUtc: '2026-06-09T11:00:00Z' }],
    });

    assert.deepEqual(plan.unscheduled, [{
      taskId: 'only-task',
      reason: 'No available shop-hours slot found within 2 days.',
    }]);
  });

  it('converts business-local opening hours across timezone offsets', () => {
    const plan = planProductionSchedule({
      candidates: [
        { id: 'ny-task', assignedMembershipId: workerId, estimatedMinutes: 60, priorityRank: 1, stageOrder: 1, dependsOnTaskIds: [] },
      ],
      reservations: [],
      weeklyHours: hours,
      holidays: [],
      timeZone: 'America/New_York',
      startUtc: new Date('2026-06-08T12:00:00Z'),
      horizonDays: 1,
    });

    assert.equal(plan.scheduled[0].startUtc.toISOString(), '2026-06-08T13:00:00.000Z');
  });
});
