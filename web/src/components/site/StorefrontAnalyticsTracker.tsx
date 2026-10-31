'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { CONSENT_CHANGED_EVENT, pageViewRequest } from '@/lib/storefront-analytics';
import { storefrontConsentKey } from '@/lib/storefront-consent';

/**
 * Counts a page view only when the business has analytics on and this visitor accepted them. It sends the path, nothing else:
 * no cookie, no identifier, no referrer. A failed request is dropped silently; analytics never affects the page.
 */
export default function StorefrontAnalyticsTracker({ siteSlug, analyticsEnabled }: { siteSlug: string; analyticsEnabled: boolean }) {
  const pathname = usePathname();
  const counted = useRef<string | null>(null);

  useEffect(() => {
    if (!analyticsEnabled) return undefined;
    function maybeCount() {
      let raw: string | null = null;
      try { raw = window.localStorage.getItem(storefrontConsentKey(siteSlug)); } catch { return; }
      const request = pageViewRequest({ siteSlug, analyticsEnabled, consentRaw: raw, pathname });
      if (!request || counted.current === request.body.path) return;
      counted.current = request.body.path;
      void fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        credentials: 'omit',
        cache: 'no-store',
        keepalive: true,
      }).catch(() => { /* analytics must never break the page */ });
    }
    maybeCount();
    window.addEventListener(CONSENT_CHANGED_EVENT, maybeCount);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, maybeCount);
  }, [analyticsEnabled, pathname, siteSlug]);

  return null;
}
