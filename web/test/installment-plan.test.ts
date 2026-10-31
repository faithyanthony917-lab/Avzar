import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/problem';
import { customPlanProblem, installmentBadgeClass, installmentLabel, installmentMessage } from '@/lib/installment-plan';

describe('installment labels', () => {
  it('reads Overdue for an unpaid or part-paid installment past its own date', () => {
    expect(installmentLabel({ status: 'Due', overdue: true })).toBe('Overdue');
    expect(installmentLabel({ status: 'PartPaid', overdue: true })).toBe('Overdue');
    expect(installmentLabel({ status: 'PartPaid', overdue: false })).toBe('Part paid');
    expect(installmentLabel({ status: 'Paid', overdue: false })).toBe('Paid');
    expect(installmentLabel({ status: 'Credited', overdue: false })).toBe('Credited');
    expect(installmentBadgeClass({ status: 'Due', overdue: true })).toContain('ap-badge-off');
    expect(installmentBadgeClass({ status: 'Paid', overdue: false })).toContain('ap-badge-on');
  });
});

describe('custom plan check', () => {
  const rows = (...pairs: [string, string][]) => pairs.map(([dueDate, amount]) => ({ dueDate, amount }));
  it('accepts dates in order that add up to the balance', () => {
    expect(customPlanProblem(rows(['2026-11-01', '70'], ['2026-12-01', '30.00']), 100)).toBe('');
  });
  it('explains each fixable problem', () => {
    expect(customPlanProblem(rows(['2026-11-01', '100']), 100)).toMatch(/at least two/);
    expect(customPlanProblem(rows(['', '50'], ['2026-12-01', '50']), 100)).toMatch(/due date for installment 1/);
    expect(customPlanProblem(rows(['2026-12-01', '50'], ['2026-11-01', '50']), 100)).toMatch(/in order/);
    expect(customPlanProblem(rows(['2026-11-01', '0'], ['2026-12-01', '100']), 100)).toMatch(/above zero/);
    expect(customPlanProblem(rows(['2026-11-01', '50.123'], ['2026-12-01', '49.877']), 100)).toMatch(/2 decimal places/);
    expect(customPlanProblem(rows(['2026-11-01', '60'], ['2026-12-01', '30']), 100)).toMatch(/add up to 90\.00 but the balance is 100\.00/);
  });
});

describe('installment messages', () => {
  it('turns the known refusals into plain language and falls back to the server text', () => {
    expect(installmentMessage(new ApiError(403, 'x', 'feature_not_in_plan'))).toMatch(/Upgrade/);
    expect(installmentMessage(new ApiError(409, 'x', 'installment_plan_exists'))).toMatch(/Cancel it/);
    expect(installmentMessage(new ApiError(400, 'The installments add up to 90.00 but the balance is 100.00.', 'installments_do_not_match_balance'))).toMatch(/add up to 90/);
    expect(installmentMessage(new ApiError(500, 'The server had a problem.'))).toBe('The server had a problem.');
  });
});
