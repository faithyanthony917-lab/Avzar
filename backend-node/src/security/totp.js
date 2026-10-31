// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s, +/-2 step window).
// The authenticator key stays in AspNetUserTokens ("[AspNetUserStore]" / "AuthenticatorKey") as unpadded base32, which is what
// ASP.NET Identity wrote, so existing enrolments keep working.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const STEP_SECONDS = 30;
export const WINDOW_STEPS = 2;
export const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function computeCode(key, step) {
  const message = Buffer.alloc(8);
  message.writeBigInt64BE(BigInt(step));
  const hash = createHmac('sha1', key).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(binary % 1_000_000).padStart(DIGITS, '0');
}

export const stepAt = (date) => Math.floor(date.getTime() / 1000 / STEP_SECONDS);

/** The time step whose code equals `code`, or null. Every step in the window is compared (no early exit). */
export function findStep(key, code, now = new Date()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const supplied = Buffer.from(code, 'ascii');
  let match = null;
  const current = stepAt(now);
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset += 1) {
    const step = current + offset;
    if (timingSafeEqual(Buffer.from(computeCode(key, step), 'ascii'), supplied)) match = step;
  }
  return match;
}

export function encodeBase32(bytes) {
  let bits = 0; let buffer = 0; let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += ALPHABET[(buffer >> bits) & 31]; }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(text) {
  if (!text || !String(text).trim()) return null;
  const clean = String(text).replaceAll(' ', '').replaceAll('-', '').replace(/=+$/, '').toUpperCase();
  const bytes = [];
  let buffer = 0; let bits = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  return bytes.length ? Buffer.from(bytes) : null;
}

export const newAuthenticatorKey = () => encodeBase32(randomBytes(20));
