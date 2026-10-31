import { STOREFRONT_CONSENT_VERSION, storefrontTrackingToken } from './storefront-consent';

/** Browser code reaches the API only through the same-origin /backend proxy. */
const BASE = '/backend/api/storefront-analytics';

export type AnalyticsEndpoint = 'consent' | 'event';

export function analyticsUrl(siteSlug: string, endpoint: AnalyticsEndpoint): string {
  return `${BASE}/${encodeURIComponent(siteSlug)}/${endpoint}`;
}

/**
 * The storefront-relative path to count, or null if the page should not be counted. On a storefront's own host the address bar shows
 * "/about"; on the shared host it is "/sites/<slug>/about", so that prefix is removed. Query strings and fragments never leave the browser.
 */
export function analyticsPath(pathname: string | null | undefined, siteSlug: string): string | null {
  if (typeof pathname !== 'string') return null;
  const prefix = `/sites/${siteSlug}`;
  let path = pathname.split(/[?#]/, 1)[0] ?? '';
  if (path === prefix || path.startsWith(`${prefix}/`)) path = path.slice(prefix.length) || '/';
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  path = path.toLowerCase();
  if (path.length > 200 || !/^\/[a-z0-9\-._~/]*$/.test(path)) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.length > 4 || segments.some((segment) => segment === '.' || segment === '..' || segment.length > 80)) return null;
  return path;
}

export type PageViewRequest = { url: string; body: { type: 'page_view'; path: string; consentToken: string } };

/**
 * Decides whether this page view may be sent, and builds the request. Nothing is sent unless the business has analytics on AND the visitor
 * has a saved, current, server-confirmed acceptance. Returns null otherwise.
 */
export function pageViewRequest(args: { siteSlug: string; analyticsEnabled: boolean; consentRaw: string | null; pathname: string | null | undefined; now?: Date }): PageViewRequest | null {
  if (!args.analyticsEnabled) return null;
  const token = storefrontTrackingToken(args.consentRaw, args.now);
  const path = analyticsPath(args.pathname, args.siteSlug);
  if (!token || !path) return null;
  return { url: analyticsUrl(args.siteSlug, 'event'), body: { type: 'page_view', path, consentToken: token } };
}

export function consentRequest(siteSlug: string, analytics: boolean, consentToken?: string): { url: string; body: { version: number; decision: 'accepted' | 'rejected'; consentToken?: string } } {
  return { url: analyticsUrl(siteSlug, 'consent'), body: { version: STOREFRONT_CONSENT_VERSION, decision: analytics ? 'accepted' : 'rejected', ...(!analytics && consentToken ? { consentToken } : {}) } };
}

export type ConsentReply = { recorded?: boolean; analyticsEnabled?: boolean; consentToken?: string };

/** What the browser stores after the server answers a consent decision. Analytics is only "on" when the server handed back a token. */
export function storedChoiceFrom(analytics: boolean, reply: ConsentReply | null): { analytics: boolean; token?: string } {
  if (!analytics) return { analytics: false };
  if (reply?.analyticsEnabled && typeof reply.consentToken === 'string' && reply.consentToken) return { analytics: true, token: reply.consentToken };
  return { analytics: false };
}

/** Name of the window event that tells the page tracker the visitor's choice changed. */
export const CONSENT_CHANGED_EVENT = 'avzar:storefront-consent-changed';
