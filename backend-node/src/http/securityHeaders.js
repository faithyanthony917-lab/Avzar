// Response headers set on every answer. The policy text is unchanged from before; this file adds
// cross-origin-opener-policy always and strict-transport-security in production (180 days, no subdomains, no preload).
// Step 17a adds cross-origin-resource-policy and cache-control: no-store on `/api` answers. There is no `helmet` package, by decision.
export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

export function securityHeaders(env = {}) {
  const production = env.NODE_ENV === 'production';
  return (req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    if (production) res.setHeader('strict-transport-security', 'max-age=15552000');
    res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
    // Answers from `/api` are for the signed-in page only: no other site may embed them and no cache may keep them.
    // A route that sets its own cache-control later (media, exports) replaces the default. Public media and pages are not under `/api`.
    if (String(req.originalUrl ?? req.url ?? '').startsWith('/api')) {
      res.setHeader('cross-origin-resource-policy', 'same-origin');
      res.setHeader('cache-control', 'no-store');
    }
    next();
  };
}
