/** Pure helpers for the same-origin API proxy (src/app/backend/[...path]/route.ts). Kept separate so they can be unit tested. */

const MAX_SEGMENTS = 12;
/** Provider callbacks (signed webhooks) are never called from a browser, so the proxy does not expose them. */
const BLOCKED_PREFIXES: string[][] = [['api', 'webhooks'], ['api', 'billing', 'subscription', 'webhook'], ['api', 'ready-to-wear', 'payment-webhook']];

/** Turns the catch-all segments into a safe upstream path, or null when the request must not be forwarded. Only /api/** is reachable. */
export function apiPath(segments: string[] | undefined): string | null {
  if (!segments || segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  if (segments[0] !== 'api') return null;
  for (const s of segments) {
    if (!s || s === '.' || s === '..' || /[\/\\%?#\u0000-\u001f]/.test(s)) return null;
  }
  const lower = segments.map((s) => s.toLowerCase());
  if (BLOCKED_PREFIXES.some((p) => p.every((x, i) => lower[i] === x))) return null;
  return segments.map(encodeURIComponent).join('/');
}

/** Browsers always send Origin on unsafe methods. A present Origin must match the host the request arrived on. */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // non-browser client; the CSRF token still applies
  if (!host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

/** The client address as seen by the trusted proxy in front of this app (the rightmost X-Forwarded-For entry), or null. */
export function clientIp(h: Headers, trustProxy: boolean): string | null {
  if (!trustProxy) return null; // otherwise a client could invent its own address and dodge the API's per-IP limits
  const xff = h.get('x-forwarded-for');
  if (!xff) return null;
  const last = xff.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last && /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last : null;
}

const FORWARD_REQUEST = ['accept', 'accept-language', 'content-type', 'cookie', 'idempotency-key', 'x-xsrf-token', 'user-agent'];

/** Only an allow-list of request headers reaches the API (no Authorization, Host or hop-by-hop headers). */
export function upstreamHeaders(incoming: Headers, trustProxy: boolean): Headers {
  const out = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = incoming.get(name);
    if (v) out.set(name, v);
  }
  const ip = clientIp(incoming, trustProxy);
  if (ip) out.set('x-forwarded-for', ip);
  return out;
}

const FORWARD_RESPONSE = ['content-type', 'content-disposition', 'retry-after', 'content-language', 'x-total-count', 'x-result-limit', 'x-truncated'];

/** API responses are never cached by the browser or a CDN; every Set-Cookie is kept. */
export function responseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.get(name);
    if (v) out.set(name, v);
  }
  for (const c of upstream.getSetCookie()) out.append('set-cookie', c);
  out.set('cache-control', 'no-store');
  return out;
}
