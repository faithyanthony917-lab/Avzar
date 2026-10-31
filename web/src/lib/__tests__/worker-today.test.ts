import { describe, expect, it } from 'vitest';
import {
  WORKER_TABS, collidingLeaves, collisionLabel, conflictsByLeaveId, formatLeaveRange, leaveStatusText, parseWorkerShow,
  type LeaveConflict, type LeaveConflictsReport,
} from '../worker-today';

function leave(leaveId: string, over: Partial<LeaveConflict> = {}): LeaveConflict {
  return {
    leaveId, membershipId: 'm1', workerName: 'Ada', startsAtUtc: '2026-10-27T08:00:00Z', endsAtUtc: '2026-10-27T16:00:00Z', reason: 'Wedding',
    status: 'Approved', affectedTaskCount: 1, affectedTasksTruncated: false, affectedTasks: [], ...over,
  };
}
const report = (leaves: LeaveConflict[]): LeaveConflictsReport => ({ asOfUtc: '2026-10-26T12:00:00Z', scopedToLocations: false, leaves });

describe('worker tabs', () => {
  it('reads the show parameter, defaulting to open tasks', () => {
    expect(parseWorkerShow(undefined)).toBe('open');
    expect(parseWorkerShow('today')).toBe('today');
    expect(parseWorkerShow('completed')).toBe('completed');
    expect(parseWorkerShow('all')).toBe('all');
    expect(parseWorkerShow('nonsense')).toBe('open');
    expect(parseWorkerShow(['today', 'all'])).toBe('today');
  });
  it('puts Today first and keeps the existing links', () => {
    expect(WORKER_TABS.map((tab) => [tab.show, tab.href])).toEqual([
      ['today', '/tasks?show=today'], ['open', '/tasks'], ['completed', '/tasks?show=completed'], ['all', '/tasks?show=all'],
    ]);
  });
});

describe('formatLeaveRange', () => {
  const zone = 'Africa/Lagos'; // UTC+1, no daylight saving
  it('shows one day with its hours', () => {
    expect(formatLeaveRange('2026-10-27T08:00:00Z', '2026-10-27T16:00:00Z', zone)).toMatch(/^Tue.*27 Oct 09:00–17:00$/);
  });
  it('says "all day" for leave from midnight to midnight', () => {
    expect(formatLeaveRange('2026-10-26T23:00:00Z', '2026-10-27T23:00:00Z', zone)).toMatch(/^Tue.*27 Oct, all day$/);
    expect(formatLeaveRange('2026-10-26T23:00:00Z', '2026-10-28T23:00:00Z', zone)).toMatch(/^Tue.*27 Oct – Wed.*28 Oct, all day$/);
  });
  it('shows both ends when leave runs across days with hours', () => {
    expect(formatLeaveRange('2026-10-27T08:00:00Z', '2026-10-28T08:00:00Z', zone)).toMatch(/^Tue.*27 Oct 09:00 – Wed.*28 Oct 09:00$/);
  });
  it('uses the business day, not the UTC day', () => {
    expect(formatLeaveRange('2026-10-27T23:30:00Z', '2026-10-28T03:00:00Z', zone)).toMatch(/^Wed.*28 Oct 00:30–04:00$/);
  });
});

describe('leave collisions', () => {
  it('has words for the leave status', () => {
    expect(leaveStatusText('Pending')).toBe('Waiting for approval');
    expect(leaveStatusText('Approved')).toBe('Approved');
  });
  it('keeps only colliding leave, pending first, then by start', () => {
    const list = collidingLeaves(report([
      leave('a', { startsAtUtc: '2026-10-27T08:00:00Z' }),
      leave('none', { affectedTaskCount: 0 }),
      leave('p', { status: 'Pending', startsAtUtc: '2026-10-30T08:00:00Z' }),
      leave('b', { startsAtUtc: '2026-10-26T08:00:00Z' }),
    ]));
    expect(list.map((item) => item.leaveId)).toEqual(['p', 'b', 'a']);
  });
  it('indexes colliding leave by its ID', () => {
    const map = conflictsByLeaveId(report([leave('a'), leave('none', { affectedTaskCount: 0 })]));
    expect(Object.keys(map)).toEqual(['a']);
  });
  it('words the count, with a plus when the list was cut', () => {
    expect(collisionLabel({ affectedTaskCount: 1, affectedTasksTruncated: false })).toBe('Collides with 1 planned task');
    expect(collisionLabel({ affectedTaskCount: 3, affectedTasksTruncated: false })).toBe('Collides with 3 planned tasks');
    expect(collisionLabel({ affectedTaskCount: 50, affectedTasksTruncated: true })).toBe('Collides with 50+ planned tasks');
  });
});
