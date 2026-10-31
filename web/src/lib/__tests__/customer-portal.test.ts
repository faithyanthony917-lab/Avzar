import { describe, expect, it } from 'vitest';
import { portalTokenFromHash } from '../customer-portal';

describe('customer portal bearer token parsing', () => {
  it('extracts a token from a URL fragment', () => expect(portalTokenFromHash('#secure-token_123')).toBe('secure-token_123'));
  it('accepts a raw token for callers that already parsed the URL', () => expect(portalTokenFromHash('secure-token')).toBe('secure-token'));
  it('rejects empty, whitespace-containing, fragment-injected and oversized tokens', () => {
    expect(portalTokenFromHash('#')).toBeNull();
    expect(portalTokenFromHash('#bad token')).toBeNull();
    expect(portalTokenFromHash('#one#two')).toBeNull();
    expect(portalTokenFromHash(`#${'x'.repeat(4097)}`)).toBeNull();
  });
});
