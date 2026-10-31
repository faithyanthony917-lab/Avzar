// Response headers set on every answer. The policy text is unchanged from before; this file adds
// cross-origin-opener-policy always and strict-transport-security in production (180 days, no subdomains, no preload).
export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

export function securityHeaders(env = {}) {
  const production = env.NODE_ENV === 'production';
  return (_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    if (production) res.setHeader('strict-transport-security', 'max-age=15552000');
    res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
    next();
  };
}
