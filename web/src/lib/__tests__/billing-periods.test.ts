import { describe, expect, it } from 'vitest';
import { actionStartsCheckout, planAction, planActionNote, priceForPeriod } from '../billing-view-model';

const starter = { code: 'starter', monthlyPrice: 5000 };
const pro = { code: 'professional', monthlyPrice: 10000 };
const date = (iso: string) => iso.slice(0, 10);

describe('planAction with a billing period', () => {
  const onStarterMonthly = { planCode: 'starter', status: 'Active' };
  it('renews the same plan when the selected period matches the current one', () => {
    expect(planAction(onStarterMonthly, starter, 5000, { selectedPeriod: 'monthly', currentPeriod: 'monthly' })).toBe('renew');
    expect(planAction(onStarterMonthly, starter, 5000, { selectedPeriod: 'annual', currentPeriod: 'annual' })).toBe('renew');
  });
  it('offers monthly -> annual on the same plan as a switch, not a renewal', () => {
    expect(planAction(onStarterMonthly, starter, 5000, { selectedPeriod: 'annual', currentPeriod: 'monthly' })).toBe('switch_to_annual');
  });
  it('does not offer annual -> monthly while the annual period runs', () => {
    expect(planAction(onStarterMonthly, starter, 5000, { selectedPeriod: 'monthly', currentPeriod: 'annual' })).toBe('monthly_after_annual');
  });
  it('keeps the old behaviour when the current period is unknown or not given', () => {
    expect(planAction(onStarterMonthly, starter, 5000)).toBe('renew');
    expect(planAction(onStarterMonthly, starter, 5000, { selectedPeriod: 'annual', currentPeriod: null })).toBe('renew');
    expect(planAction(onStarterMonthly, starter, 5000, { selectedPeriod: 'annual' })).toBe('renew');
  });
  it('orders different plans by monthly price whichever period is selected', () => {
    for (const selectedPeriod of ['monthly', 'annual'] as const) {
      for (const currentPeriod of ['monthly', 'annual'] as const) {
        expect(planAction(onStarterMonthly, pro, 5000, { selectedPeriod, currentPeriod })).toBe('upgrade');
        expect(planAction({ planCode: 'professional', status: 'Active' }, starter, 10000, { selectedPeriod, currentPeriod })).toBe('downgrade');
      }
    }
  });
  it('treats a period choice as irrelevant when not subscribed to a running paid plan', () => {
    expect(planAction({ planCode: 'starter', status: 'PastDue' }, starter, 5000, { selectedPeriod: 'monthly', currentPeriod: 'annual' })).toBe('subscribe');
    expect(planAction({ planCode: 'free', status: 'Active' }, starter, 0, { selectedPeriod: 'annual', currentPeriod: 'monthly' })).toBe('subscribe');
  });
});

describe('actionStartsCheckout', () => {
  it('goes to checkout for subscribe, renew, upgrade and monthly -> annual only', () => {
    expect(actionStartsCheckout('subscribe')).toBe(true);
    expect(actionStartsCheckout('renew')).toBe(true);
    expect(actionStartsCheckout('upgrade')).toBe(true);
    expect(actionStartsCheckout('switch_to_annual')).toBe(true);
    expect(actionStartsCheckout('downgrade')).toBe(false);
    expect(actionStartsCheckout('monthly_after_annual')).toBe(false);
    expect(actionStartsCheckout('unavailable')).toBe(false);
  });
});

describe('planActionNote', () => {
  it('explains that monthly -> annual keeps the remaining paid time', () => {
    expect(planActionNote('switch_to_annual', '2026-11-19T00:00:00Z', date)).toContain('2026-11-19');
    expect(planActionNote('switch_to_annual', '2026-11-19T00:00:00Z', date)).toContain('nothing is lost');
  });
  it('explains why annual -> monthly waits for the renewal date', () => {
    expect(planActionNote('monthly_after_annual', '2027-06-01T00:00:00Z', date)).toContain('2027-06-01');
  });
  it('mentions the credit on an upgrade and stays quiet for plain subscribe', () => {
    expect(planActionNote('upgrade', null, date)).toContain('credited');
    expect(planActionNote('subscribe', null, date)).toBeNull();
  });
});

describe('annual interval pricing', () => {
  it('uses the annual price for the annual period and rejects a missing or zero annual price', () => {
    const plan = { monthlyPrice: 5000, annualPrice: 50000 };
    expect(priceForPeriod(plan, 'annual')).toBe(50000);
    expect(priceForPeriod({ ...plan, annualPrice: 0 }, 'annual')).toBeNull();
    expect(priceForPeriod({ ...plan, annualPrice: null }, 'annual')).toBeNull();
    expect(priceForPeriod(plan, 'monthly')).toBe(5000);
  });
});
