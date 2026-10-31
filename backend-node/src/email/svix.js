// Port of SvixSignature (the scheme Resend uses): HMAC-SHA256 over "{id}.{timestamp}.{body}", key = base64 part of "whsec_...".
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

/** Returns the key bytes, or null when the secret does not look like whsec_ + base64 (at least 16 bytes). */
export function parseSecret(secret) {
  if (typeof secret !== 'string') return null;
  const s = secret.trim();
  if (!s.startsWith(SECRET_PREFIX)) return null;
  const b64 = s.slice(SECRET_PREFIX.length);
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const key = Buffer.from(b64, 'base64');
  return key.length >= 16 ? key : null;
}

export function sign(key, id, timestamp, body) {
  const payload = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')]);
  return createHmac('sha256', key).update(payload).digest('base64');
}

/** True only for a fresh message (within the tolerance, both directions) carrying at least one valid v1 signature. */
export function verify(key, id, timestamp, signatureHeader, body, nowMs = Date.now(), toleranceMs = DEFAULT_TOLERANCE_MS) {
  if (!id || id.length > 200 || !timestamp || !signatureHeader || signatureHeader.length > 2000) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const sentMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(sentMs) || Math.abs(nowMs - sentMs) > toleranceMs) return false;

  const expected = Buffer.from(sign(key, id, timestamp, body), 'ascii');
  let valid = false;
  for (const part of signatureHeader.split(/\s+/).filter(Boolean)) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== 'v1') continue;
    const candidate = Buffer.from(part.slice(comma + 1), 'ascii');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) valid = true;
  }
  return valid;
}
