// Single-purpose, expiring, HMAC-signed links for email confirmation and password reset. ASP.NET Identity's DataProtection tokens cannot
// be validated outside .NET, so links issued by the old API stop working at cut-over (they were short-lived: 24 h / 30 min). Each token
// is bound to a fingerprint of the user's current state (SecurityStamp plus the field the action changes), so it dies as soon as the
// password changes, the stamp rotates or the email changes: reset links work once.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PURPOSE_CONFIRM_EMAIL = 'confirm_email';
export const PURPOSE_RESET_PASSWORD = 'reset_password';

export function accountTokenKey(env) {
  const base = env.ACCOUNT_TOKEN_KEY || env.JWT_SIGNING_KEY;
  if (!base || base.length < 32) return null;
  return createHmac('sha256', base).update('avzar:account-tokens:v1').digest();
}

const fingerprint = (user, purpose) => createHash('sha256')
  .update(`${user.SecurityStamp ?? ''}|${purpose === PURPOSE_RESET_PASSWORD ? (user.PasswordHash ?? '') : (user.Email ?? '')}`)
  .digest('base64url').slice(0, 32);

const sign = (key, payload) => createHmac('sha256', key).update(payload).digest('base64url');

export function issueAccountToken(key, user, purpose, ttlSeconds, now = new Date()) {
  const payload = Buffer.from(JSON.stringify({ u: user.Id, p: purpose, e: Math.floor(now.getTime() / 1000) + ttlSeconds, f: fingerprint(user, purpose) })).toString('base64url');
  return `${payload}.${sign(key, payload)}`;
}

export function verifyAccountToken(key, user, purpose, token, now = new Date()) {
  if (!key || !user || typeof token !== 'string' || token.length > 2000) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return false;
  const expected = Buffer.from(sign(key, payload)); const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return false; }
  if (claims.u !== user.Id || claims.p !== purpose || !(claims.e > Math.floor(now.getTime() / 1000))) return false;
  const a = Buffer.from(String(claims.f)); const b = Buffer.from(fingerprint(user, purpose));
  return a.length === b.length && timingSafeEqual(a, b);
}
