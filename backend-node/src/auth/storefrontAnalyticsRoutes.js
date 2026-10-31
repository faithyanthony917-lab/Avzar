import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { createPostgresAnalyticsProvider } from './storefrontAnalyticsProvider.js';
import { getAnalyticsSettings, getAnalyticsSummary, recordConsentDecision, recordPageView, setAnalyticsEnabled } from './storefrontAnalyticsService.js';

/** Public visitor endpoints live under this prefix. They carry no cookie or credential, so CSRF does not apply to them (see http/app.js). */
export const STOREFRONT_ANALYTICS_PUBLIC_PREFIX = '/api/storefront-analytics/';

export function createStorefrontAnalyticsRouter({ env, pool, secret, provider = createPostgresAnalyticsProvider(pool), now = () => new Date() }) {
  const router = Router();
  const auth = requireBearerAuth(env, pool);
  const consentLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const eventLimit = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
  const settingsLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const context = () => ({ pool, provider, secret, now: now() });

  router.post('/storefront-analytics/:slug/consent', consentLimit, async (req, res) =>
    res.status(202).set('cache-control', 'no-store').json(await recordConsentDecision(context(), req.params.slug, req.body)));
  router.post('/storefront-analytics/:slug/event', eventLimit, async (req, res) =>
    res.status(202).set('cache-control', 'no-store').json(await recordPageView(context(), req.params.slug, req.body)));

  const owner = [settingsLimit, auth, requirePermission('business.settings')];
  router.get('/business/storefront-analytics/settings', ...owner, async (req, res) =>
    res.status(200).json(await getAnalyticsSettings(pool, req.currentUser)));
  router.put('/business/storefront-analytics/settings', ...owner, async (req, res) =>
    res.status(200).json(await setAnalyticsEnabled(pool, req.currentUser, req.body)));
  router.get('/business/storefront-analytics/summary', ...owner, async (req, res) =>
    res.status(200).json(await getAnalyticsSummary({ pool, provider, now: now() }, req.currentUser, req.query)));

  return router;
}
