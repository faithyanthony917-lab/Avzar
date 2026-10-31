// Step 16d: inbound WhatsApp messages from Meta's webhook. Only one thing matters here: a customer replying STOP (or START).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { inboundKeyword, normalizePhone } from './optOut.js';

export const WHATSAPP_MAX_MESSAGES_PER_REQUEST = 100;

/** Meta signs the exact bytes it sends: header "sha256=<hex>", HMAC-SHA256 with the app secret. */
export function verifyMetaSignature(appSecret, rawBody, header) {
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof header !== 'string') return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time comparison of two secrets of any length. */
export function sameSecret(a, b) {
  const left = createHash('sha256').update(String(a ?? '')).digest();
  const right = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(left, right);
}

// "Stop." and "STOP!" mean stop. Only punctuation and spaces at the ends are ignored; the word itself must still be exactly a keyword.
const trimEnds = (text) => String(text ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// A tapped button carries a payload and a visible title; either may hold the keyword.
function candidatesOf(message) {
  if (message?.type === 'text') return [message.text?.body];
  if (message?.type === 'button') return [message.button?.payload, message.button?.text];
  if (message?.type === 'interactive') return [message.interactive?.button_reply?.id, message.interactive?.button_reply?.title];
  return [];
}

/**
 * Reads a webhook payload and returns [{ keyword: 'stop' | 'start', address }] in the order received. Anything else (delivery statuses,
 * images, other numbers, malformed shapes) is ignored, never an error: Meta must always get a 200 for a request it signed.
 */
export function extractWhatsAppReplies(payload, { phoneNumberId = '' } = {}) {
  const found = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (phoneNumberId && String(value?.metadata?.phone_number_id ?? '') !== String(phoneNumberId)) continue;
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        if (found.length >= WHATSAPP_MAX_MESSAGES_PER_REQUEST) return found;
        const keyword = candidatesOf(message).map((candidate) => inboundKeyword(trimEnds(candidate))).find(Boolean) ?? null;
        const address = normalizePhone(`+${String(message?.from ?? '').replace(/\D/g, '')}`);
        if (keyword && address) found.push({ keyword, address });
      }
    }
  }
  return found;
}
