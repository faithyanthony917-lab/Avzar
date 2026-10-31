// Replaces ASP.NET antiforgery. Signed double-submit: GET /api/auth/csrf sets cookie `tailoring.csrf` and returns the same value;
// unsafe requests must echo it in X-XSRF-TOKEN. Requests carrying "Authorization: Bearer" are exempt (browsers cannot forge that
// header cross-site and mobile has no cookie); a bad bearer token never falls back to the cookie, so the exemption cannot bypass it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/errors.js';

export const CSRF_COOKIE = 'tailoring.csrf';
export const CSRF_HEADER = 'x-xsrf-token';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return null; }
  }
  return null;
}

const mac = (nonce, secret) => createHmac('sha256', secret).update(nonce).digest('base64url');
export function newCsrfToken(secret) { const n = randomBytes(24).toString('base64url'); return `${n}.${mac(n, secret)}`; }
export function isValidCsrfToken(token, secret) {
  if (typeof token !== 'string') return false;
  const [n, m, extra] = token.split('.');
  if (!n || !m || extra !== undefined) return false;
  const a = Buffer.from(m), b = Buffer.from(mac(n, secret));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function csrfProtection({ secret, ignore = () => false }) {
  return (req, _res, next) => {
    if (SAFE.has(req.method) || ignore(req)) return next();
    if (/^Bearer /i.test(req.get('authorization') ?? '')) return next();
    const cookieHeader = req.headers?.cookie ?? (req.cookies && req.cookies[CSRF_COOKIE] ? `${CSRF_COOKIE}=${req.cookies[CSRF_COOKIE]}` : undefined);
    const cookie = readCookie(cookieHeader, CSRF_COOKIE), header = req.get(CSRF_HEADER);
    const ok = cookie && header && cookie.length === header.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(header)) && isValidCsrfToken(header, secret);
    if (!ok) return next(new AppError(400, 'invalid_csrf', 'Missing or invalid CSRF token. Fetch /api/auth/csrf and send it in the X-XSRF-TOKEN header.'));
    next();
  };
}
