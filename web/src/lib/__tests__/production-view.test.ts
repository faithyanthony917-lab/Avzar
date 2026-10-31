import { describe, expect, it } from 'vitest';
import {
  addDays, attentionItems, boardColumnApiQuery, dayStatusText, flagLabels, formatMinutes, formatSlotTimes, groupSlotsByDay,
  isPlanBlocked, isRealDate, localDate, parseViewQuery, rangeApiQuery, viewHref, workloadCell,
  type AttentionCounts, type TaskFlags, type ViewTask, type WorkloadDay,
} from '../production-view';

const noFlags: TaskFlags = { overdue: false, blocked: false, unassigned: false, noEstimate: false, lateAgainstDeadline: false, insideLeave: false };
function slot(taskId: string, startUtc: string, endUtc: string): ViewTask {
  return {
    taskId, orderId: 'o1', orderNumber: 'ORD-1', title: `Task ${taskId}`, stageName: 'Cutting', status: 'Scheduled', priority: 'Normal',
    membershipId: 'm1', workerName: 'Ada', startUtc, endUtc, deadlineUtc: null, estimatedMinutes: 60, flags: noFlags,
  };
}

describe('parseViewQuery', () => {
  it('defaults to the list view with the calendar length', () => {
    expect(parseViewQuery({})).toEqual({ view: 'list', from: '', days: 7 });
  });
  it('uses a longer default for the workload tab', () => {
    expect(parseViewQuery({ view: 'workload' })).toEqual({ view: 'workload', from: '', days: 14 });
  });
  it('accepts allowed lengths and a real start date', () => {
    expect(parseViewQuery({ view: 'workload', days: '28', from: '2026-10-26' })).toEqual({ view: 'workload', from: '2026-10-26', days: 28 });
    expect(parseViewQuery({ view: 'calendar', days: '14' }).days).toBe(14);
  });
  it('ignores lengths the tab does not offer', () => {
    expect(parseViewQuery({ view: 'workload', days: '30' }).days).toBe(14);
    expect(parseViewQuery({ view: 'calendar', days: '28' }).days).toBe(7);
    expect(parseViewQuery({ view: 'calendar', days: 'abc' }).days).toBe(7);
  });
  it('drops an impossible date and an unknown view', () => {
    expect(parseViewQuery({ from: '2026-02-30' }).from).toBe('');
    expect(parseViewQuery({ from: "2026-10-26'; drop" }).from).toBe('');
    expect(parseViewQuery({ view: 'bogus' }).view).toBe('list');
  });
  it('reads the first value when a parameter repeats', () => {
    expect(parseViewQuery({ view: ['board', 'workload'] }).view).toBe('board');
  });
});

describe('links and queries', () => {
  it('builds tab links', () => {
    expect(viewHref('list')).toBe('/tasks');
    expect(viewHref('calendar')).toBe('/tasks?view=calendar');
    expect(viewHref('workload', { from: '2026-10-26', days: 7 })).toBe('/tasks?view=workload&from=2026-10-26&days=7');
  });
  it('builds the API range query', () => {
    expect(rangeApiQuery({ from: '', days: 14 })).toBe('days=14');
    expect(rangeApiQuery({ from: '2026-10-26', days: 14 })).toBe('days=14&from=2026-10-26');
  });
  it('asks the task list for one status at a time', () => {
    expect(boardColumnApiQuery('Pending')).toBe('page=1&pageSize=25&status=Pending');
  });
});

describe('isPlanBlocked', () => {
  it('is true only for a 403 with the plan code', () => {
    expect(isPlanBlocked({ ok: false, status: 403, code: 'feature_not_in_plan' })).toBe(true);
    expect(isPlanBlocked({ ok: false, status: 403, code: 'forbidden' })).toBe(false);
    expect(isPlanBlocked({ ok: false, status: 403 })).toBe(false);
    expect(isPlanBlocked({ ok: false, status: 500, code: 'feature_not_in_plan' })).toBe(false);
    expect(isPlanBlocked({ ok: true })).toBe(false);
  });
});

describe('attention', () => {
  const counts: AttentionCounts = { openTasks: 12, overdue: 2, blocked: 1, unassigned: 4, noEstimate: 3, lateAgainstDeadline: 0, insideLeave: 1 };
  it('lists six counts and links overdue, blocked and planned-during-leave', () => {
    const items = attentionItems(counts);
    expect(items.map((i) => i.count)).toEqual([2, 1, 4, 3, 0, 1]);
    expect(items.filter((i) => i.href).map((i) => [i.key, i.href])).toEqual([
      ['overdue', '/tasks?overdue=true'],
      ['blocked', '/tasks?status=Blocked'],
      ['insideLeave', '/workers/schedule#leave-collisions'],
    ]);
  });
  it('names only the flags that are set, in a fixed order', () => {
    expect(flagLabels({ ...noFlags, insideLeave: true, overdue: true })).toEqual(['Overdue', 'Planned during leave']);
    expect(flagLabels(noFlags)).toEqual([]);
    expect(flagLabels(null)).toEqual([]);
  });
});

describe('minutes and workload cells', () => {
  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(390)).toBe('6h 30m');
    expect(formatMinutes(-5)).toBe('0m');
  });
  const day = (over: Partial<WorkloadDay>): WorkloadDay => ({ date: '2026-10-26', capacityMinutes: 480, plannedMinutes: 0, leaveMinutes: 0, utilization: 0, status: 'ok', reason: null, ...over });
  it('shows planned against capacity', () => {
    expect(workloadCell(day({ plannedMinutes: 360 })).text).toBe('6h / 8h');
  });
  it('names why a day has no capacity', () => {
    expect(workloadCell(day({ capacityMinutes: 0, status: 'off', reason: 'holiday' })).text).toBe('Holiday');
    expect(workloadCell(day({ capacityMinutes: 0, status: 'off', reason: 'leave' })).text).toBe('On leave');
    expect(workloadCell(day({ capacityMinutes: 0, status: 'off', reason: null })).text).toBe('No capacity');
  });
  it('still shows planned work on a day with no capacity', () => {
    const cell = workloadCell(day({ capacityMinutes: 0, plannedMinutes: 60, status: 'over', reason: 'closed' }));
    expect(cell.text).toBe('1h / 0m');
    expect(cell.statusText).toBe('Over capacity');
  });
  it('has words for every status', () => {
    expect(['ok', 'near', 'over', 'off'].map(dayStatusText)).toEqual(['Within capacity', 'Near capacity', 'Over capacity', 'No capacity']);
  });
});

describe('business-local dates', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('checks real dates', () => {
    expect(isRealDate('2026-10-26')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('26-10-2026')).toBe(false);
  });
  it('reads the local day around a clock change', () => {
    // Europe/London clocks go back on 2026-10-25: 00:30 BST is still the 25th though it is the 24th in UTC.
    expect(localDate('2026-10-24T23:30:00Z', 'Europe/London')).toBe('2026-10-25');
    expect(localDate('2026-10-25T23:30:00Z', 'Europe/London')).toBe('2026-10-25');
    expect(localDate('2026-10-26T00:00:00Z', 'Europe/London')).toBe('2026-10-26');
  });
  it('falls back to UTC for an unknown zone instead of throwing', () => {
    expect(localDate('2026-10-26T12:00:00Z', 'Not/AZone')).toBe('2026-10-26');
  });
  it('formats slot times in the business zone', () => {
    expect(formatSlotTimes('2026-10-26T08:00:00Z', '2026-10-26T10:30:00Z', 'Africa/Lagos')).toBe('09:00–11:30');
    expect(formatSlotTimes('2026-10-26T22:00:00Z', '2026-10-27T01:00:00Z', 'Africa/Lagos')).toMatch(/^23:00–02:00 \(ends .*27 Oct\)$/);
    expect(formatSlotTimes(null, null, 'Africa/Lagos')).toBe('Not planned');
  });
});

describe('groupSlotsByDay', () => {
  const zone = 'Africa/Lagos';
  it('returns every day of the window, sorted, with early starters on the first day', () => {
    const a = slot('a', '2026-10-26T07:00:00Z', '2026-10-26T08:00:00Z');
    const b = slot('b', '2026-10-26T05:00:00Z', '2026-10-26T06:00:00Z');
    const c = slot('c', '2026-10-25T20:00:00Z', '2026-10-26T04:00:00Z'); // started before the window
    const d = slot('d', '2026-10-28T09:00:00Z', '2026-10-28T10:00:00Z');
    const days = groupSlotsByDay([a, d, b, c], '2026-10-26', 3, zone);
    expect(days.map((x) => x.date)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
    expect(days.map((x) => x.slots.map((s) => s.taskId))).toEqual([['c', 'b', 'a'], [], ['d']]);
  });
  it('uses the business day, not the UTC day', () => {
    // 23:30 UTC on the 26th is 00:30 on the 27th in Lagos.
    const days = groupSlotsByDay([slot('x', '2026-10-26T23:30:00Z', '2026-10-27T00:30:00Z')], '2026-10-26', 2, zone);
    expect(days.map((x) => x.slots.length)).toEqual([0, 1]);
  });
  it('ignores a slot with no start', () => {
    const odd = { ...slot('z', '2026-10-26T07:00:00Z', '2026-10-26T08:00:00Z'), startUtc: null };
    expect(groupSlotsByDay([odd], '2026-10-26', 1, zone)[0]!.slots).toEqual([]);
  });
});
