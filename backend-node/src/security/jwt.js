// Minimal HS256 access tokens for the mobile app (ids only; permissions are always resolved server-side per request).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/errors.js';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const sig = (data, key) => createHmac('sha256', key).update(data).digest();

export function mobileTokensEnabled(auth) { return typeof auth.jwtSigningKey === 'string' && auth.jwtSigningKey.length >= 32; }

export function issueAccessToken(auth, { userId, businessId, sessionId }, now = new Date()) {
  if (!mobileTokensEnabled(auth)) throw new AppError(503, 'mobile_auth_not_configured', 'Mobile sign-in is not enabled on this server.');
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + Math.max(1, auth.accessTokenMinutes) * 60;
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: auth.jwtIssuer, aud: auth.jwtAudience, iat, nbf: iat, exp, sub: userId, bid: businessId, sid: sessionId });
  const token = `${head}.${body}.${sig(`${head}.${body}`, auth.jwtSigningKey).toString('base64url')}`;
  return { token, expiresAtUtc: new Date(exp * 1000) };
}

/** Returns the claims, or null for ANY problem (bad signature, wrong alg/iss/aud, expired). Never falls back to cookies. */
export function verifyAccessToken(auth, token, now = new Date()) {
  if (!mobileTokensEnabled(auth) || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null; // rejects alg=none and algorithm confusion
    const expected = sig(`${parts[0]}.${parts[1]}`, auth.jwtSigningKey), given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const t = Math.floor(now.getTime() / 1000);
    if (c.iss !== auth.jwtIssuer || c.aud !== auth.jwtAudience || !(c.exp > t) || (c.nbf ?? 0) > t) return null;
    if (!c.sub || !c.bid || !c.sid) return null;
    return { userId: c.sub, businessId: c.bid, sessionId: c.sid };
  } catch { return null; }
}
