import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createAiProvider } from './aiProvider.js';
import { askTextAssistant, buildAssistant, generateFashionDesign, generateStructuredTextDraft, saveFashionDesign } from './aiService.js';
import { createBillingProvider } from './billingProvider.js';
import { createCheckout, handlePaystackWebhook } from './subscriptionBillingService.js';
import { cancelScheduledChange, scheduleChange, startTrial } from './subscriptionLifecycleService.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';

export const SAVE_DESIGN_PATH = '/api/ai/fashion-design/save';
export const WEBHOOK_PATH = '/api/billing/subscription/webhook';

export function createBillingRouter({ env, pool, storage, billingProvider = createBillingProvider(env), aiProvider = createAiProvider(env) }) {
  const router = Router();
  const auth = requireBearerAuth(env, pool);
  const authLimit = rateLimit({ windowMs: 60_000, limit: env.BILLING_ACTION_RATE_LIMIT_PER_MINUTE ?? 10, standardHeaders: true, legacyHeaders: false });
  const uploadLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
  // PNG up to 12 MB becomes ~16 MB of base64; the global 1 MB parser is skipped for this one path and applied here after auth.
  const largeJson = express.json({ limit: '18mb', strict: true });

  router.post('/billing/subscription/checkout', authLimit, auth, requirePermission('business.settings'), async (req, res) =>
    res.status(200).json(await createCheckout(pool, env, billingProvider, req.currentUser, req.body)));

  router.post('/billing/subscription/trial', authLimit, auth, requirePermission('business.settings'), async (req, res) =>
    res.status(200).json(await startTrial(pool, env, req.currentUser, req.body)));

  router.post('/billing/subscription/change', authLimit, auth, requirePermission('business.settings'), async (req, res) =>
    res.status(200).json(await scheduleChange(pool, req.currentUser, req.body)));

  router.post('/billing/subscription/change/cancel', authLimit, auth, requirePermission('business.settings'), async (req, res) =>
    res.status(200).json(await cancelScheduledChange(pool, req.currentUser)));

  router.post('/billing/subscription/webhook', publicLimit, async (req, res) => {
    const status = await handlePaystackWebhook(pool, billingProvider, req.rawBody, req.get('x-paystack-signature') ?? '');
    return res.status(status).end();
  });

  router.post('/ai/fashion-design', authLimit, auth, requirePermission('designs.manage'), async (req, res) =>
    res.status(200).json(await generateFashionDesign(pool, env, aiProvider, req.currentUser, req.body)));

  router.post('/ai/fashion-design/save', uploadLimit, auth, requirePermission('media.manage'), largeJson, async (req, res) =>
    res.status(200).json(await saveFashionDesign(pool, env, storage, req.currentUser, req.body)));

  router.post('/ai/assistant-builder', authLimit, auth, requirePermission('storefront.edit'), async (req, res) =>
    res.status(200).json(await buildAssistant(pool, env, aiProvider, req.currentUser, req.body)));

  router.post('/ai/text-assistant', authLimit, auth, requirePermission('storefront.edit'), async (req, res) =>
    res.status(200).json(await askTextAssistant(pool, env, aiProvider, req.currentUser, req.body)));

  router.post('/ai/text-assistant/drafts', authLimit, auth, requirePermission('storefront.edit'), async (req, res) =>
    res.status(200).json(await generateStructuredTextDraft(pool, env, aiProvider, req.currentUser, req.body)));

  return router;
}
