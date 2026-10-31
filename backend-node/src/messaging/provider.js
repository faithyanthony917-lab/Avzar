/** Provider-neutral outbound messaging contract. Concrete vendors are injected by deployment configuration. */
import { TWILIO_OPTED_OUT_CODE } from './optOut.js';
import { isMessagingSuppressed } from './suppressions.js';

export class MessagingProviderError extends Error {
  constructor(message, { retryable = false, code = 'provider_error' } = {}) {
    super(message);
    this.name = 'MessagingProviderError';
    this.retryable = Boolean(retryable);
    this.code = String(code).slice(0, 80);
  }
}

export function createMessagingProvider({ sendWhatsApp, sendSms } = {}) {
  return Object.freeze({
    async send({ channel, to, text, idempotencyKey, template }) {
      if (!['WhatsApp', 'SMS'].includes(channel)) throw new TypeError('Unsupported messaging channel.');
      if (!String(to ?? '').trim() || !String(text ?? '').trim()) throw new TypeError('A recipient and message are required.');
      if (!String(idempotencyKey ?? '').trim()) throw new TypeError('An idempotency key is required.');
      const sender = channel === 'WhatsApp' ? sendWhatsApp : sendSms;
      if (typeof sender !== 'function') {
        throw new MessagingProviderError(`${channel} provider is not configured.`, { retryable: false, code: 'provider_not_configured' });
      }
      try {
        const result = await sender({ to: String(to).trim(), text: String(text), idempotencyKey: String(idempotencyKey), template: channel === 'WhatsApp' ? template : undefined });
        if (!result || typeof result.providerMessageId !== 'string' || !result.providerMessageId.trim()) {
          throw new MessagingProviderError('Provider returned no message identifier.', { retryable: true, code: 'invalid_provider_response' });
        }
        return { channel, providerMessageId: result.providerMessageId, acceptedAtUtc: result.acceptedAtUtc ?? new Date().toISOString() };
      } catch (error) {
        if (error instanceof MessagingProviderError) throw error;
        throw new MessagingProviderError('Outbound messaging provider request failed.', { retryable: true, code: 'provider_request_failed' });
      }
    },
  });
}

/** Fail closed: sending needs an explicit, current OptedIn record for this business AND no standing sender-wide stop (STOP reply or provider refusal). */
export async function customerMessagingConsent(db, { businessId, customerId, channel, address }) {
  if (!['WhatsApp', 'SMS'].includes(channel)) return false;
  if (await isMessagingSuppressed(db, { channel, address })) return false;
  const { rows } = await db.query(`
    SELECT 1 FROM "CustomerMessagingPreferences"
    WHERE "BusinessId" = $1 AND "CustomerId" = $2 AND "Channel" = $3
      AND lower("Address") = lower($4) AND "ConsentStatus" = 'OptedIn'
      AND "ConsentedAtUtc" IS NOT NULL AND "OptedOutAtUtc" IS NULL
    LIMIT 1`, [businessId, customerId, channel, address]);
  return rows.length > 0;
}

/** Step 16d: the Graph API body. A message template (approved by Meta) is how a business starts a conversation; plain text only works inside a 24-hour window. */
export function buildWhatsAppPayload({ to, text, template }) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to).replace(/^\+/, '') };
  if (template && typeof template.name === 'string' && Array.isArray(template.parameters)) {
    return {
      ...base, type: 'template',
      template: { name: template.name, language: { code: template.language || 'en' }, components: [{ type: 'body', parameters: template.parameters.map((value) => ({ type: 'text', text: String(value) })) }] },
    };
  }
  return { ...base, type: 'text', text: { preview_url: false, body: text } };
}

// Meta error codes (to be confirmed against a live account in step 20). 131050: the person stopped messages from this sender.
const WHATSAPP_OPTED_OUT_CODES = new Set([131050]);
const WHATSAPP_RETRY_CODES = new Set([130429, 131056, 80007]);
const WHATSAPP_NO_RETRY_CODES = new Set([131047, 131026, 131030, 132000, 132001, 132005, 132007, 132012, 132015, 132016]);

/** Turns a failed Graph API answer into a provider error. Only the numeric code is kept, never the body, so no message text reaches a log. */
export function whatsappFailure(status, detail) {
  const metaCode = Number(detail?.error?.code);
  if (WHATSAPP_OPTED_OUT_CODES.has(metaCode)) return new MessagingProviderError('Recipient has opted out.', { retryable: false, code: 'recipient_opted_out' });
  if (Number.isInteger(metaCode) && metaCode > 0) {
    const retryable = WHATSAPP_RETRY_CODES.has(metaCode) || (!WHATSAPP_NO_RETRY_CODES.has(metaCode) && (status === 429 || status >= 500));
    return new MessagingProviderError('WhatsApp provider rejected the request.', { retryable, code: `whatsapp_meta_${metaCode}` });
  }
  return new MessagingProviderError('WhatsApp provider rejected the request.', { retryable: status === 429 || status >= 500, code: `whatsapp_http_${status}` });
}

/** Build real provider adapters from environment configuration; no credentials are required when unused. */
export function createConfiguredMessagingProvider(env = process.env, { fetchImpl = fetch } = {}) {
  const sendSms = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM
    ? async ({ to, text, idempotencyKey }) => {
      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`;
      const body = new URLSearchParams({ To: to, From: env.TWILIO_SMS_FROM, Body: text });
      const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey }, body, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        // Twilio refuses a recipient who replied STOP to the sender with error 21610. Never retry that: it becomes a standing stop.
        let detail = null;
        try { detail = await response.json(); } catch { detail = null; }
        if (Number(detail?.code) === TWILIO_OPTED_OUT_CODE) throw new MessagingProviderError('Recipient has opted out.', { retryable: false, code: 'recipient_opted_out' });
        throw new MessagingProviderError('SMS provider rejected the request.', { retryable: response.status === 429 || response.status >= 500, code: `sms_http_${response.status}` });
      }
      const data = await response.json();
      if (!data.sid) throw new MessagingProviderError('SMS provider returned an invalid response.', { retryable: true, code: 'invalid_provider_response' });
      return { providerMessageId: data.sid };
    }
    : undefined;
  const sendWhatsApp = env.META_WHATSAPP_ACCESS_TOKEN && env.META_WHATSAPP_PHONE_NUMBER_ID
    ? async ({ to, text, idempotencyKey, template }) => {
      const version = /^[vV]\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? '') ? env.META_GRAPH_API_VERSION : 'v23.0';
      const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(env.META_WHATSAPP_PHONE_NUMBER_ID)}/messages`;
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(buildWhatsAppPayload({ to, text, template })), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        let detail = null;
        try { detail = await response.json(); } catch { detail = null; }
        throw whatsappFailure(response.status, detail);
      }
      const data = await response.json();
      if (!data.messages?.[0]?.id) throw new MessagingProviderError('WhatsApp provider returned an invalid response.', { retryable: true, code: 'invalid_provider_response' });
      return { providerMessageId: data.messages[0].id };
    }
    : undefined;
  return createMessagingProvider({ sendSms, sendWhatsApp });
}

/** Consent-gated send primitive for reminder workers and future customer messaging workflows. */
export async function sendCustomerMessage(db, provider, message) {
  const permitted = await customerMessagingConsent(db, message);
  if (!permitted) return { sent: false, reason: 'consent_required' };
  const result = await provider.send(message);
  return { sent: true, ...result };
}
