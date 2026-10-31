export const STOREFRONT_CONSENT_VERSION = 2;

/** A saved choice is asked again after this many days (keep equal to CONSENT_TTL_DAYS in the API, which stops accepting its token then). */
export const STOREFRONT_CONSENT_MAX_AGE_DAYS = 180;

export type StorefrontConsent = {
  version: number;
  analytics: boolean;
  savedAt: string;
  /** Proof from the server that this storefront recorded an "accepted" decision. Present only when analytics is accepted. */
  token?: string;
};

export function storefrontConsentKey(siteSlug: string): string {
  return `avzar:storefront-consent:v${STOREFRONT_CONSENT_VERSION}:${siteSlug}`;
}

export function parseStorefrontConsent(raw: string | null): StorefrontConsent | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<StorefrontConsent>;
    if (candidate.version !== STOREFRONT_CONSENT_VERSION || typeof candidate.analytics !== 'boolean' || typeof candidate.savedAt !== 'string') return null;
    const token = typeof candidate.token === 'string' && candidate.token.length > 0 && candidate.token.length <= 200 ? candidate.token : undefined;
    return { version: STOREFRONT_CONSENT_VERSION, analytics: candidate.analytics, savedAt: candidate.savedAt, ...(token ? { token } : {}) };
  } catch {
    return null;
  }
}

export function createStorefrontConsent(analytics: boolean, now = new Date(), token?: string): StorefrontConsent {
  return { version: STOREFRONT_CONSENT_VERSION, analytics, savedAt: now.toISOString(), ...(analytics && token ? { token } : {}) };
}

/** True when the saved choice is older than the maximum age, so the visitor should be asked again. */
export function isStorefrontConsentExpired(consent: StorefrontConsent, now = new Date()): boolean {
  const saved = Date.parse(consent.savedAt);
  if (!Number.isFinite(saved)) return true;
  return now.getTime() - saved > STOREFRONT_CONSENT_MAX_AGE_DAYS * 86_400_000;
}

/** The token that lets analytics be sent, or null. Needs a saved, current, affirmative choice that the server confirmed. */
export function storefrontTrackingToken(raw: string | null, now = new Date()): string | null {
  const consent = parseStorefrontConsent(raw);
  if (!consent || !consent.analytics || !consent.token || isStorefrontConsentExpired(consent, now)) return null;
  return consent.token;
}

export function hasStorefrontAnalyticsConsent(raw: string | null): boolean {
  return parseStorefrontConsent(raw)?.analytics === true;
}
