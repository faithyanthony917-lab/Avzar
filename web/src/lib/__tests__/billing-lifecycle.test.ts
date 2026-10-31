import { describe, expect, it } from 'vitest';
import { lifecycleNotices, planAction, statusLabel, type SubscriptionView } from '../billing-view-model';

const base: SubscriptionView = {
  planCode: 'free', status: 'Active', trialEndsAtUtc: null, graceEndsAtUtc: null, suspendedPlanCode: null,
  pendingPlanCode: null, pendingPlanName: null, currentPeriodEndUtc: null,
};
const date = (iso: string) => iso.slice(0, 10);

describe('planAction', () => {
  const starter = { code: 'starter', monthlyPrice: 5000 };
  const pro = { code: 'professional', monthlyPrice: 10000 };
  const paid = { planCode: 'professional', status: 'Active' };
  it('offers subscribe on Free, during a trial, in grace and when suspended', () => {
    expect(planAction({ planCode: 'free', status: 'Active' }, starter, 0)).toBe('subscribe');
    expect(planAction({ planCode: 'professional', status: 'Trialing' }, starter, 10000)).toBe('subscribe');
    expect(planAction({ planCode: 'starter', status: 'PastDue' }, starter, 5000)).toBe('subscribe');
    expect(planAction({ planCode: 'free', status: 'Expired' }, pro, 0)).toBe('subscribe');
  });
  it('renews the current plan, upgrades to a dearer one and schedules a cheaper one', () => {
    expect(planAction(paid, pro, 10000)).toBe('renew');
    expect(planAction(paid, { code: 'business', monthlyPrice: 20000 }, 10000)).toBe('upgrade');
    expect(planAction(paid, starter, 10000)).toBe('downgrade');
  });
  it('is unavailable when the price cannot be compared or is equal', () => {
    expect(planAction(paid, starter, null)).toBe('unavailable');
    expect(planAction(paid, { code: 'other', monthlyPrice: 10000 }, 10000)).toBe('unavailable');
  });
});

describe('lifecycleNotices', () => {
  it('has nothing to say for a plain Free or active subscription', () => {
    expect(lifecycleNotices(base, date)).toEqual([]);
    expect(lifecycleNotices({ ...base, planCode: 'starter', currentPeriodEndUtc: '2026-11-19T00:00:00Z' }, date)).toEqual([]);
  });
  it('explains a trial, the grace period and a suspension, and says data is kept', () => {
    const trial = lifecycleNotices({ ...base, planCode: 'professional', status: 'Trialing', trialEndsAtUtc: '2026-11-02T00:00:00Z' }, date);
    expect(trial[0]?.text).toContain('2026-11-02');
    expect(trial[0]?.text).toContain('nothing is deleted');
    const grace = lifecycleNotices({ ...base, planCode: 'starter', status: 'PastDue', graceEndsAtUtc: '2026-11-26T00:00:00Z' }, date);
    expect(grace[0]?.tone).toBe('warn');
    expect(grace[0]?.text).toContain('2026-11-26');
    const suspended = lifecycleNotices({ ...base, status: 'Expired', suspendedPlanCode: 'starter' }, date);
    expect(suspended[0]?.tone).toBe('warn');
    expect(suspended[0]?.text).toContain('data is kept');
  });
  it('announces a scheduled plan change with its date', () => {
    const notices = lifecycleNotices({ ...base, planCode: 'professional', pendingPlanCode: 'starter', pendingPlanName: 'Starter', currentPeriodEndUtc: '2026-11-19T00:00:00Z' }, date);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('Starter');
    expect(notices[0]?.text).toContain('2026-11-19');
  });
});

describe('statusLabel', () => {
  it('uses plain words', () => {
    expect(statusLabel('PastDue')).toBe('Payment overdue');
    expect(statusLabel('Expired')).toBe('Suspended');
    expect(statusLabel('Trialing')).toBe('Trial');
    expect(statusLabel('Active')).toBe('Active');
  });
});
