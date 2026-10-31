import { describe, expect, it } from 'vitest';
import { analyticsPath, analyticsUrl, consentRequest, pageViewRequest, storedChoiceFrom } from '../storefront-analytics';
import { createStorefrontConsent, isStorefrontConsentExpired, parseStorefrontConsent, storefrontTrackingToken } from '../storefront-consent';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const accepted = (token = 'tok.1', at = NOW) => JSON.stringify(createStorefrontConsent(true, at, token));

describe('analytics endpoints', () => {
  it('goes through the same-origin /backend proxy', () => {
    expect(analyticsUrl('atelier-one', 'event')).toBe('/backend/api/storefront-analytics/atelier-one/event');
    expect(analyticsUrl('atelier-one', 'consent')).toBe('/backend/api/storefront-analytics/atelier-one/consent');
  });
  it('sends the decision and the notice version', () => {
    expect(consentRequest('atelier-one', true).body).toEqual({ version: 2, decision: 'accepted' });
    expect(consentRequest('atelier-one', false).body).toEqual({ version: 2, decision: 'rejected' });
    expect(consentRequest('atelier-one', false, 'prior-token').body).toEqual({ version: 2, decision: 'rejected', consentToken: 'prior-token' });
    expect(consentRequest('atelier-one', true, 'ignored-token').body).toEqual({ version: 2, decision: 'accepted' });
  });
});

describe('analyticsPath', () => {
  it('keeps storefront-relative paths and drops query strings and fragments', () => {
    expect(analyticsPath('/', 'atelier-one')).toBe('/');
    expect(analyticsPath('/About/?utm=1#top', 'atelier-one')).toBe('/about');
    expect(analyticsPath('/design/silk-gown', 'atelier-one')).toBe('/design/silk-gown');
  });
  it('removes the /sites/<slug> prefix used on the shared host', () => {
    expect(analyticsPath('/sites/atelier-one', 'atelier-one')).toBe('/');
    expect(analyticsPath('/sites/atelier-one/about', 'atelier-one')).toBe('/about');
    expect(analyticsPath('/sites/other-site/about', 'atelier-one')).toBe('/sites/other-site/about');
  });
  it('refuses paths the API would refuse', () => {
    expect(analyticsPath(null, 'atelier-one')).toBeNull();
    expect(analyticsPath('about', 'atelier-one')).toBeNull();
    expect(analyticsPath('//evil.example', 'atelier-one')).toBeNull();
    expect(analyticsPath('/a/b/c/d/e', 'atelier-one')).toBeNull();
    expect(analyticsPath('/caf%C3%A9', 'atelier-one')).toBeNull();
    expect(analyticsPath(`/${'a'.repeat(300)}`, 'atelier-one')).toBeNull();
  });
});

describe('pageViewRequest: nothing is sent without consent', () => {
  const base = { siteSlug: 'atelier-one', analyticsEnabled: true, pathname: '/about', now: NOW };
  it('is null when the business has analytics off, even with a saved acceptance', () => {
    expect(pageViewRequest({ ...base, analyticsEnabled: false, consentRaw: accepted() })).toBeNull();
  });
  it('is null with no saved choice, a rejection, malformed storage or an acceptance the server never confirmed', () => {
    expect(pageViewRequest({ ...base, consentRaw: null })).toBeNull();
    expect(pageViewRequest({ ...base, consentRaw: JSON.stringify(createStorefrontConsent(false, NOW)) })).toBeNull();
    expect(pageViewRequest({ ...base, consentRaw: 'not json' })).toBeNull();
    expect(pageViewRequest({ ...base, consentRaw: JSON.stringify({ version: 2, analytics: true, savedAt: NOW.toISOString() }) })).toBeNull();
  });
  it('is null once the saved choice is older than 180 days, and for an older notice version', () => {
    const old = new Date(NOW.getTime() - 181 * 86_400_000);
    expect(pageViewRequest({ ...base, consentRaw: accepted('tok.1', old) })).toBeNull();
    expect(pageViewRequest({ ...base, consentRaw: JSON.stringify({ version: 0, analytics: true, savedAt: NOW.toISOString(), token: 't' }) })).toBeNull();
  });
  it('is null for a page that cannot be counted', () => {
    expect(pageViewRequest({ ...base, pathname: '/a/b/c/d/e', consentRaw: accepted() })).toBeNull();
  });
  it('builds a request carrying only the type, the path and the consent token', () => {
    const request = pageViewRequest({ ...base, pathname: '/sites/atelier-one/About?x=1', consentRaw: accepted('tok.9') });
    expect(request).toEqual({ url: '/backend/api/storefront-analytics/atelier-one/event', body: { type: 'page_view', path: '/about', consentToken: 'tok.9' } });
  });
});

describe('storedChoiceFrom', () => {
  it('turns analytics on only when the server confirmed it with a token', () => {
    expect(storedChoiceFrom(true, { recorded: true, analyticsEnabled: true, consentToken: 't' })).toEqual({ analytics: true, token: 't' });
    expect(storedChoiceFrom(true, { recorded: false, analyticsEnabled: false })).toEqual({ analytics: false });
    expect(storedChoiceFrom(true, { recorded: true, analyticsEnabled: true })).toEqual({ analytics: false });
    expect(storedChoiceFrom(true, null)).toEqual({ analytics: false });
  });
  it('a rejection is always saved as off, with no token', () => {
    expect(storedChoiceFrom(false, null)).toEqual({ analytics: false });
    expect(storedChoiceFrom(false, { recorded: true, analyticsEnabled: true, consentToken: 't' })).toEqual({ analytics: false });
  });
});

describe('consent record with a token', () => {
  it('keeps the token only for an acceptance and round-trips it', () => {
    const yes = createStorefrontConsent(true, NOW, 'tok.1');
    expect(parseStorefrontConsent(JSON.stringify(yes))).toEqual(yes);
    expect(createStorefrontConsent(false, NOW, 'tok.1')).toEqual({ version: 2, analytics: false, savedAt: NOW.toISOString() });
  });
  it('expires after 180 days and treats an unreadable date as expired', () => {
    const saved = createStorefrontConsent(true, NOW, 't');
    expect(isStorefrontConsentExpired(saved, new Date(NOW.getTime() + 179 * 86_400_000))).toBe(false);
    expect(isStorefrontConsentExpired(saved, new Date(NOW.getTime() + 181 * 86_400_000))).toBe(true);
    expect(isStorefrontConsentExpired({ ...saved, savedAt: 'garbage' }, NOW)).toBe(true);
  });
  it('gives a tracking token only for a current, confirmed acceptance', () => {
    expect(storefrontTrackingToken(accepted('abc'), NOW)).toBe('abc');
    expect(storefrontTrackingToken(null, NOW)).toBeNull();
  });
});
