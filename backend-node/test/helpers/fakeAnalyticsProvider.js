/** In-memory test fake for the storefront analytics provider interface (see src/auth/storefrontAnalyticsProvider.js). Scopes every read to the tenant. */
export function createFakeAnalyticsProvider() {
  const views = [];
  const consents = [];
  const grants = new Map();
  return {
    views,
    consents,
    grants,
    async recordPageView(event) { views.push({ ...event }); },
    async recordConsent(event) {
      consents.push({ businessId: event.businessId, storefrontId: event.storefrontId, version: event.version, decision: event.decision });
      if (event.tokenHash && event.expiresAt) grants.set(event.tokenHash, { businessId: event.businessId, storefrontId: event.storefrontId, version: event.version, expiresAt: event.expiresAt, revoked: false });
    },
    async registerConsentToken(event) { grants.set(event.tokenHash, { ...event, revoked: false }); },
    async revokeConsentToken({ businessId, storefrontId, tokenHash }) {
      const grant = grants.get(tokenHash);
      if (grant && grant.businessId === businessId && grant.storefrontId === storefrontId) grant.revoked = true;
    },
    async isConsentTokenActive({ businessId, storefrontId, tokenHash, now }) {
      const grant = grants.get(tokenHash);
      return Boolean(grant && grant.businessId === businessId && grant.storefrontId === storefrontId && !grant.revoked && grant.expiresAt > now);
    },
    async summary({ businessId, storefrontId, fromDay, toDay }) {
      const mine = views.filter((view) => view.businessId === businessId && (!storefrontId || view.storefrontId === storefrontId) && view.day >= fromDay && view.day <= toDay);
      const daily = new Map();
      const paths = new Map();
      for (const view of mine) {
        daily.set(view.day, (daily.get(view.day) ?? 0) + 1);
        paths.set(view.path, (paths.get(view.path) ?? 0) + 1);
      }
      const decided = consents.filter((entry) => entry.businessId === businessId && (!storefrontId || entry.storefrontId === storefrontId));
      return {
        daily: [...daily].map(([day, count]) => ({ day, views: count })).sort((a, b) => a.day.localeCompare(b.day)),
        topPaths: [...paths].map(([path, count]) => ({ path, views: count })).sort((a, b) => b.views - a.views).slice(0, 10),
        consent: { accepted: decided.filter((entry) => entry.decision === 'accepted').length, rejected: decided.filter((entry) => entry.decision === 'rejected').length },
      };
    },
  };
}
