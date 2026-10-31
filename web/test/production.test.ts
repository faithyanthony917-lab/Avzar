import { describe, expect, it } from 'vitest';
import { managerTaskApiQuery, managerTaskListHref, parseManagerTaskQuery, taskNeedsAttention, taskPageCount, taskStatusLabel, taskStatusTone, workerTaskApiQuery } from '../src/lib/production';

describe('production task query parsing', () => {
  it('defaults to an unfiltered first page', () => expect(parseManagerTaskQuery({})).toEqual({ status: '', stage: '', overdue: false, page: 1 }));
  it('accepts known filters and trims stage', () => expect(parseManagerTaskQuery({ status: 'Blocked', stage: '  Cutting  ', overdue: 'true', page: '3' })).toEqual({ status: 'Blocked', stage: 'Cutting', overdue: true, page: 3 }));
  it('rejects unknown statuses and invalid pages', () => expect(parseManagerTaskQuery({ status: 'Hack', page: '0' })).toEqual({ status: '', stage: '', overdue: false, page: 1 }));
  it('limits repeated and overly long values safely', () => expect(parseManagerTaskQuery({ stage: 'x'.repeat(120), page: ['2', '3'] })).toEqual({ status: '', stage: 'x'.repeat(80), overdue: false, page: 2 }));
});

describe('production query URLs', () => {
  it('includes only active manager filters', () => expect(managerTaskApiQuery({ status: 'Blocked', stage: 'Cutting room', overdue: true, page: 2 })).toBe('page=2&pageSize=25&status=Blocked&stage=Cutting+room&overdue=true'));
  it('preserves filters when paging', () => expect(managerTaskListHref({ status: 'Pending', stage: 'Sewing', overdue: true, page: 2 }, { page: 3 })).toBe('/tasks?status=Pending&stage=Sewing&overdue=true&page=3'));
  it('omits defaults from clean links', () => expect(managerTaskListHref({ status: '', stage: '', overdue: false, page: 1 })).toBe('/tasks'));
  it('sends worker view mode to the assigned-only endpoint', () => expect(workerTaskApiQuery('completed', 2)).toBe('page=2&pageSize=25&show=completed'));
});

describe('task display helpers', () => {
  it('labels statuses and uses neutral fallback tones', () => {
    expect(taskStatusLabel('InProgress')).toBe('In progress');
    expect(taskStatusTone('Completed')).toBe('on');
    expect(taskStatusTone('Blocked')).toBe('off');
    expect(taskStatusTone('Unexpected')).toBe('neutral');
  });
  it('calculates page counts safely', () => {
    expect(taskPageCount(0, 25)).toBe(1);
    expect(taskPageCount(51, 25)).toBe(3);
    expect(taskPageCount(51, 0)).toBe(51);
  });
  it('flags overdue, blocked and dependency-ineligible tasks', () => {
    expect(taskNeedsAttention({ isOverdue: true, status: 'Pending', unmetDependencies: 0, isEligible: true })).toBe(true);
    expect(taskNeedsAttention({ isOverdue: false, status: 'Blocked', unmetDependencies: 0, isEligible: false })).toBe(true);
    expect(taskNeedsAttention({ isOverdue: false, status: 'Pending', unmetDependencies: 1, isEligible: false })).toBe(true);
    expect(taskNeedsAttention({ isOverdue: false, status: 'Pending', unmetDependencies: 0, isEligible: true })).toBe(false);
  });
});
