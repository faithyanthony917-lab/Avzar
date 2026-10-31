import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { adoptTenant } from '../db/tenantRlsContext.js';
import { inboundKeyword, maskPhone, messagingSigningSecret, normalizePhone, verifyTwilioSignature, verifyUnsubscribeToken } from './optOut.js';
import { liftMessagingSuppression, recordMessagingSuppression } from './suppressions.js';
import { extractWhatsAppReplies, sameSecret, verifyMetaSignature } from './whatsappInbound.js';

export const UNSUBSCRIBE_PREVIEW_PATH = '/api/messaging/unsubscribe/preview';
export const UNSUBSCRIBE_CONFIRM_PATH = '/api/messaging/unsubscribe/confirm';
export const TWILIO_INBOUND_PATH = '/api/messaging/twilio/inbound';
export const WHATSAPP_WEBHOOK_PATH = '/api/messaging/whatsapp/webhook';
/** Source written on a preference the customer opted out of themselves through the link. Staff cannot record OptedIn over it. */
export const CUSTOMER_LINK_SOURCE = 'customer_link';

const tokenBody = z.object({ token: z.string().min(20).max(200) });
// Forged, malformed, unknown and wrong-business links all look the same to the caller, so a link cannot be probed.
const invalidLink = () => new AppError(404, 'unsubscribe_link_invalid', 'This unsubscribe link is not valid.');

export function createPublicMessagingRouter({ env, pool }) {
  const router = Router();
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const webhookLimit = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
  const secret = messagingSigningSecret(env);

  // The signed token proves which business and preference it names; no database is touched before the signature checks out.
  function readToken(body) {
    const parsed = tokenBody.safeParse(body ?? {});
    const ids = parsed.success ? verifyUnsubscribeToken(secret, parsed.data.token) : null;
    if (!ids) throw invalidLink();
    return ids;
  }

  router.post('/messaging/unsubscribe/preview', publicLimit, async (req, res) => {
    const { businessId, preferenceId } = readToken(req.body);
    adoptTenant(businessId);
    const { rows } = await pool.query(
      `SELECT p."Channel", p."Address", p."ConsentStatus", b."Name" AS "BusinessName"
       FROM "CustomerMessagingPreferences" p JOIN "Businesses" b ON b."Id" = p."BusinessId"
       WHERE p."Id" = $1 AND p."BusinessId" = $2`, [preferenceId, businessId]);
    if (!rows[0]) throw invalidLink();
    res.set('cache-control', 'no-store');
    res.status(200).json({ businessName: rows[0].BusinessName, channel: rows[0].Channel, maskedAddress: maskPhone(rows[0].Address), alreadyOptedOut: rows[0].ConsentStatus === 'OptedOut' });
  });

  router.post('/messaging/unsubscribe/confirm', publicLimit, async (req, res) => {
    const { businessId, preferenceId } = readToken(req.body);
    adoptTenant(businessId);
    // The update fires the existing trigger, which cancels every queued reminder for this customer and channel.
    const { rows } = await pool.query(
      `UPDATE "CustomerMessagingPreferences" p SET "ConsentStatus" = 'OptedOut', "ConsentSource" = $3, "ConsentedAtUtc" = NULL,
         "OptedOutAtUtc" = CASE WHEN p."ConsentStatus" = 'OptedOut' THEN p."OptedOutAtUtc" ELSE now() END, "UpdatedAtUtc" = now()
       FROM "Businesses" b WHERE p."Id" = $1 AND p."BusinessId" = $2 AND b."Id" = p."BusinessId"
       RETURNING p."Channel", p."Address", b."Name" AS "BusinessName"`, [preferenceId, businessId, CUSTOMER_LINK_SOURCE]);
    if (!rows[0]) throw invalidLink();
    res.set('cache-control', 'no-store');
    res.status(200).json({ optedOut: true, businessName: rows[0].BusinessName, channel: rows[0].Channel, maskedAddress: maskPhone(rows[0].Address) });
  });

  // Inbound SMS from Twilio. One sender number serves every shop, so STOP stops the number everywhere (a sender-wide stop,
  // MessagingSuppressions) and START lifts only that stop; it never restores any business's consent.
  router.post('/messaging/twilio/inbound', webhookLimit, express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const authToken = env.TWILIO_AUTH_TOKEN;
    if (!authToken) throw new AppError(503, 'sms_webhook_not_configured', 'Inbound SMS is not configured.');
    const base = String(env.TWILIO_INBOUND_WEBHOOK_URL || (env.PUBLIC_BASE_URL ? `${String(env.PUBLIC_BASE_URL).replace(/\/+$/, '')}${TWILIO_INBOUND_PATH}` : ''));
    if (!base || !verifyTwilioSignature(authToken, base, req.body ?? {}, req.get('x-twilio-signature'))) {
      throw new AppError(403, 'invalid_signature', 'The request signature is not valid.');
    }
    const keyword = inboundKeyword(req.body?.Body);
    const address = normalizePhone(req.body?.From);
    if (keyword && address) {
      if (keyword === 'stop') await recordMessagingSuppression(pool, { channel: 'SMS', address, source: 'SmsStop' });
      else await liftMessagingSuppression(pool, { channel: 'SMS', address });
    }
    // An empty reply: Twilio sends its own STOP and START confirmations.
    res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  // Step 16d: Meta's webhook. GET is the one-time verify handshake; POST carries inbound WhatsApp messages. As for SMS, one sender number
  // serves every shop, so STOP stops that number everywhere (a sender-wide stop) and START lifts only that stop, never any business's consent.
  router.get('/messaging/whatsapp/webhook', webhookLimit, (req, res) => {
    const token = env.META_WHATSAPP_VERIFY_TOKEN;
    if (!token) throw new AppError(503, 'whatsapp_webhook_not_configured', 'Inbound WhatsApp is not configured.');
    const challenge = String(req.query['hub.challenge'] ?? '');
    if (req.query['hub.mode'] !== 'subscribe' || !sameSecret(token, req.query['hub.verify_token'])) throw new AppError(403, 'invalid_verify_token', 'The verify token is not valid.');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) throw AppError.badRequest('invalid_challenge', 'The challenge is not valid.');
    res.status(200).type('text/plain').send(challenge);
  });

  router.post('/messaging/whatsapp/webhook', webhookLimit, async (req, res) => {
    const appSecret = env.META_WHATSAPP_APP_SECRET;
    if (!appSecret) throw new AppError(503, 'whatsapp_webhook_not_configured', 'Inbound WhatsApp is not configured.');
    if (!verifyMetaSignature(appSecret, req.rawBody, req.get('x-hub-signature-256'))) throw new AppError(403, 'invalid_signature', 'The request signature is not valid.');
    for (const { keyword, address } of extractWhatsAppReplies(req.body, { phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID })) {
      if (keyword === 'stop') await recordMessagingSuppression(pool, { channel: 'WhatsApp', address, source: 'WhatsAppStop' });
      else await liftMessagingSuppression(pool, { channel: 'WhatsApp', address });
    }
    res.status(200).json({ received: true });
  });

  return router;
}
