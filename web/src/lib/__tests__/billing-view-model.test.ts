import { describe, expect, it } from 'vitest';
import { canStartCheckout, priceForPeriod } from '../billing-view-model';

describe('billing view model', () => {
  const plan = { monthlyPrice: 2500, annualPrice: 24000 };
  it('selects the correct period price and handles unavailable annual pricing', () => {
    expect(priceForPeriod(plan, 'monthly')).toBe(2500);
    expect(priceForPeriod(plan, 'annual')).toBe(24000);
    expect(priceForPeriod({ ...plan, annualPrice: null }, 'annual')).toBeNull();
  });
  it('blocks checkout for unavailable prices and while a checkout is in progress', () => {
    expect(canStartCheckout(2500, false)).toBe(true);
    expect(canStartCheckout(null, false)).toBe(false);
    expect(canStartCheckout(2500, true)).toBe(false);
    expect(canStartCheckout(Number.POSITIVE_INFINITY, false)).toBe(false);
  });
});
