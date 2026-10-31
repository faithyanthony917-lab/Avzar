import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { handleResendWebhook } from './webhookService.js';

export const RESEND_WEBHOOK_PATH = '/api/webhooks/email/resend';

export function createEmailWebhookRouter({ env, pool }) {
  const router = Router();
  const limit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const rawBody = express.raw({ type: () => true, limit: '64kb' });

  router.post('/webhooks/email/resend', limit, rawBody, async (req, res) => {
    const outcome = await handleResendWebhook({
      pool,
      secret: env.EMAIL_RESEND_WEBHOOK_SECRET,
      id: req.get('svix-id'),
      timestamp: req.get('svix-timestamp'),
      signature: req.get('svix-signature'),
      body: req.body,
    });
    if (outcome === 'disabled') return res.sendStatus(404);
    if (outcome === 'invalid_signature') return res.sendStatus(401);
    return res.sendStatus(200);
  });

  return router;
}