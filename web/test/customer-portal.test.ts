import { describe, expect, it } from 'vitest';
import { balanceByCurrency, portalTokenFromHash } from '@/lib/customer-portal';

const inv = (over: Partial<{ number: string | null; status: string; balance: number; currencyCode: string }> = {}) => ({ number: 'INV-1', status: 'Issued', balance: 100, currencyCode: 'NGN', ...over });

describe('balanceByCurrency', () => {
  it('adds issued balances per currency, sorted by currency code', () => {
    expect(balanceByCurrency([inv({ balance: 100.1 }), inv({ balance: 50.2 }), inv({ currencyCode: 'GHS', balance: 10 })])).toEqual([
      { currency: 'GHS', amount: 10 },
      { currency: 'NGN', amount: 150.3 },
    ]);
  });
  it('ignores drafts, cancelled or void invoices and empty balances', () => {
    expect(balanceByCurrency([inv({ number: null }), inv({ status: 'Cancelled' }), inv({ status: 'Void' }), inv({ balance: 0 }), inv({ balance: -5 })])).toEqual([]);
  });
  it('returns nothing for no invoices', () => {
    expect(balanceByCurrency([])).toEqual([]);
  });
});

describe('portalTokenFromHash', () => {
  it('reads the token after the hash', () => {
    expect(portalTokenFromHash('#abc123')).toBe('abc123');
    expect(portalTokenFromHash('abc123')).toBe('abc123');
  });
  it('rejects empty, spaced or oversized tokens', () => {
    expect(portalTokenFromHash('#')).toBeNull();
    expect(portalTokenFromHash('#a b')).toBeNull();
    expect(portalTokenFromHash('#' + 'x'.repeat(4097))).toBeNull();
  });
});
