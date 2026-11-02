// Step 18b: the web helpers know the AwaitingApproval status.
import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, taskNeedsAttention, taskStatusLabel } from '@/lib/production';
import { BOARD_COLUMNS } from '@/lib/production-view';

describe('task approval status', () => {
  it('is a filterable status and a board column, with a readable label', () => {
    expect(TASK_STATUSES).toContain('AwaitingApproval');
    expect(BOARD_COLUMNS).toContain('AwaitingApproval');
    expect(taskStatusLabel('AwaitingApproval')).toBe('Awaiting approval');
  });

  it('asks a manager for attention', () => {
    const base = { isOverdue: false, unmetDependencies: 0, isEligible: true };
    expect(taskNeedsAttention({ ...base, status: 'AwaitingApproval' })).toBe(true);
    expect(taskNeedsAttention({ ...base, status: 'InProgress' })).toBe(false);
  });
});
