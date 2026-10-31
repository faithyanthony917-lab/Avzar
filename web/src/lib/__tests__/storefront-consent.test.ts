import { describe, expect, it } from 'vitest';
import {
  createStorefrontConsent,
  hasStorefrontAnalyticsConsent,
  parseStorefrontConsent,
  storefrontConsentKey,
} from '../storefront-consent';

describe('public storefront privacy consent', () => {
  it('uses a versioned key scoped to the storefront', () => {
    expect(storefrontConsentKey('atelier-one')).toBe(
      'avzar:storefront-consent:v2:atelier-one',
    );
    expect(storefrontConsentKey('atelier-one')).not.toBe(
      storefrontConsentKey('atelier-two'),
    );
  });

  it('stores an explicit choice with a timestamp', () => {
    const saved = createStorefrontConsent(
      true,
      new Date('2026-10-19T12:00:00.000Z'),
    );

    expect(saved).toEqual({
      version: 2,
      analytics: true,
      savedAt: '2026-10-19T12:00:00.000Z',
    });
    expect(parseStorefrontConsent(JSON.stringify(saved))).toEqual(saved);
  });

  it('does not allow analytics without valid affirmative consent', () => {
    expect(hasStorefrontAnalyticsConsent(null)).toBe(false);
    expect(hasStorefrontAnalyticsConsent('not json')).toBe(false);

    expect(
      hasStorefrontAnalyticsConsent(
        JSON.stringify({
          version: 2,
          analytics: false,
          savedAt: 'now',
        }),
      ),
    ).toBe(false);

    expect(
      hasStorefrontAnalyticsConsent(
        JSON.stringify({
          version: 1,
          analytics: true,
          savedAt: 'now',
        }),
      ),
    ).toBe(false);
  });

  it('allows analytics only for a valid affirmative consent record', () => {
    expect(
      hasStorefrontAnalyticsConsent(
        JSON.stringify({
          version: 2,
          analytics: true,
          savedAt: '2026-10-19T12:00:00.000Z',
        }),
      ),
    ).toBe(true);
  });

  it('rejects malformed and incomplete records', () => {
    expect(parseStorefrontConsent('{}')).toBeNull();
    expect(parseStorefrontConsent('null')).toBeNull();

    expect(
      parseStorefrontConsent(
        JSON.stringify({
          version: 2,
          analytics: 'yes',
          savedAt: 'now',
        }),
      ),
    ).toBeNull();
  });
});
