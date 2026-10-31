import { describe, expect, it } from 'vitest';
import { CHECKOUT_RETURN_POLLS, checkoutReturnMessage, checkoutReturnState, isCheckoutReturn, subscriptionSignature } from '../billing-view-model';

const reference = `avz_${'0123456789abcdef'.repeat(2)}`;

describe('returning from Paystack checkout', () => {
  it('recognises a reference this app issued, under either parameter name Paystack uses', () => {
    expect(isCheckoutReturn({ reference })).toBe(true);
    expect(isCheckoutReturn({ trxref: reference })).toBe(true);
    expect(isCheckoutReturn({ reference: [reference, 'x'] })).toBe(true);
  });

  it('ignores a missing, malformed or foreign reference', () => {
    expect(isCheckoutReturn({})).toBe(false);
    expect(isCheckoutReturn({ reference: '' })).toBe(false);
    expect(isCheckoutReturn({ reference: 'T123456789' })).toBe(false);
    expect(isCheckoutReturn({ reference: `avz_${'g'.repeat(32)}` })).toBe(false);
    expect(isCheckoutReturn({ reference: `${reference}extra` })).toBe(false);
    expect(isCheckoutReturn({ reference: ['not-ours', reference] })).toBe(false);
  });

  it('changes the signature when the plan, status, period or paid-until date changes', () => {
    const base = { planCode: 'starter', status: 'Active', billingPeriod: 'monthly' as const, currentPeriodEndUtc: '2026-11-01T00:00:00Z' };
    const same = subscriptionSignature(base);
    expect(subscriptionSignature({ ...base })).toBe(same);
    expect(subscriptionSignature({ ...base, planCode: 'pro' })).not.toBe(same);
    expect(subscriptionSignature({ ...base, status: 'Expired' })).not.toBe(same);
    expect(subscriptionSignature({ ...base, billingPeriod: 'annual' })).not.toBe(same);
    expect(subscriptionSignature({ ...base, currentPeriodEndUtc: '2026-12-01T00:00:00Z' })).not.toBe(same);
    expect(subscriptionSignature({ ...base, billingPeriod: null, currentPeriodEndUtc: null })).not.toBe(same);
  });

  it('shows nothing when the customer did not just come back from checkout', () => {
    expect(checkoutReturnState(false, false, 0)).toBe('none');
    expect(checkoutReturnState(false, true, 3)).toBe('none');
    expect(checkoutReturnMessage('none')).toBeNull();
  });

  it('keeps checking until the re-check limit, then reports a possible delay, and claims an update only when the data changed', () => {
    expect(checkoutReturnState(true, false, 0)).toBe('checking');
    expect(checkoutReturnState(true, false, CHECKOUT_RETURN_POLLS - 1)).toBe('checking');
    expect(checkoutReturnState(true, false, CHECKOUT_RETURN_POLLS)).toBe('delayed');
    expect(checkoutReturnState(true, true, 1)).toBe('updated');
    expect(checkoutReturnState(true, true, CHECKOUT_RETURN_POLLS)).toBe('updated');
  });

  it('words each state without promising a result the server has not confirmed', () => {
    expect(checkoutReturnMessage('checking')).toMatch(/as soon as the provider confirms/);
    expect(checkoutReturnMessage('updated')).toBe('Your subscription has been updated.');
    expect(checkoutReturnMessage('delayed')).toMatch(/Nothing changes until the payment is verified/);
  });
});
