import { describe, expect, it } from 'vitest';
import { canonicalStorefrontUrl } from '../storefront-slug-redirect';

describe('storefront slug redirects', () => {
  it('preserves paths and query strings when redirecting a tenant subdomain', () => {
    expect(canonicalStorefrontUrl(
      'https://old-shop.avzar.app/design/agbada?ref=campaign', 'old-shop', 'new-shop', 'avzar.app',
    )).toBe('https://new-shop.avzar.app/design/agbada?ref=campaign');
  });

  it('preserves paths and query strings on the shared storefront host', () => {
    expect(canonicalStorefrontUrl(
      'https://avzar.app/sites/old-shop/collection/favorites?sort=name', 'old-shop', 'new-shop', 'avzar.app',
    )).toBe('https://avzar.app/sites/new-shop/collection/favorites?sort=name');
  });

  it('does not rewrite an unrelated host or an unchanged slug', () => {
    expect(canonicalStorefrontUrl('https://other.example/design', 'old-shop', 'new-shop', 'avzar.app')).toBeNull();
    expect(canonicalStorefrontUrl('https://old-shop.avzar.app/', 'old-shop', 'old-shop', 'avzar.app')).toBeNull();
  });
});