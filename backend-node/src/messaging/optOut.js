import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Key for signed messaging links: the CSRF key if set, else the JWT key; null when neither is configured (links are then left out). */
export function messagingSigningSecret(env = process.env) {
  const secret = env.CSRF_SIGNING_KEY || env.JWT_SIGNING_KEY || '';
  return secret.length >= 16 ? secret : null;
}

const keyFor = (secret) => createHmac('sha256', String(secret)).update('avzar:messaging-unsubscribe:v1').digest();
const sign = (secret, payload) => createHmac('sha256', keyFor(secret)).update(payload).digest('base64url');

/** Unsubscribe token: base64url("<businessId>.<preferenceId>") + "." + HMAC. It never expires; opting out twice is harmless. */
export function createUnsubscribeToken(secret, { businessId, preferenceId }) {
  if (!secret) throw new TypeError('A signing secret is required.');
  if (!UUID.test(businessId ?? '') || !UUID.test(preferenceId ?? '')) throw new TypeError('Valid business and preference IDs are required.');
  const payload = Buffer.from(`${businessId.toLowerCase()}.${preferenceId.toLowerCase()}`).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns { businessId, preferenceId } for a genuine token, otherwise null. Forged, malformed and oversized input all give null. */
export function verifyUnsubscribeToken(secret, token) {
  if (!secret || typeof token !== 'string' || token.length > 200 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [payload, signature] = token.split('.');
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [businessId, preferenceId, extra] = Buffer.from(payload, 'base64url').toString('utf8').split('.');
  if (extra !== undefined || !UUID.test(businessId ?? '') || !UUID.test(preferenceId ?? '')) return null;
  return { businessId, preferenceId };
}

/** The link customers receive. The token sits in the fragment, so it is never sent to a server log or a referrer. */
export function unsubscribeUrl(env, secret, ids) {
  if (!secret) return null;
  return `${String(env.WEB_BASE_URL ?? '').replace(/\/+$/, '')}/unsubscribe#${createUnsubscribeToken(secret, ids)}`;
}

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

/** Classifies an inbound SMS body: 'stop', 'start' or null. Only a message that is exactly one keyword counts (Twilio's own rule). */
export function inboundKeyword(body) {
  const word = String(body ?? '').trim().toUpperCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/** E.164-style address used for stops: "+" and digits only. Returns null when it is not a phone number. */
export function normalizePhone(value) {
  const compact = String(value ?? '').replace(/[\s()-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(compact)) return null;
  return compact.startsWith('+') ? compact : `+${compact}`;
}

/** "+23480****0000": enough to recognise a number, not enough to learn it. */
export function maskPhone(address) {
  const text = String(address ?? '');
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

/** Twilio request signature: base64 HMAC-SHA1 of the full URL followed by each POST parameter name and value, sorted by name. */
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((text, key) => text + key + String(params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(authToken, url, params, header) {
  if (!authToken || typeof header !== 'string' || !header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The Twilio error code for "recipient has opted out of this sender" (21610). */
export const TWILIO_OPTED_OUT_CODE = 21610;
