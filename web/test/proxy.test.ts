import { describe, expect, it } from 'vitest';
import { apiPath, clientIp, isSameOrigin, responseHeaders, upstreamHeaders } from '../src/lib/proxy';

describe('apiPath: only /api/** is reachable and nothing can climb out of it', () => {
  it('accepts an api path', () => expect(apiPath(['api', 'auth', 'login'])).toBe('api/auth/login'));
  it('encodes segments', () => expect(apiPath(['api', 'a b'])).toBe('api/a%20b'));
  it.each([
    [undefined], [[]], [['public', 'sites', 'x']], [['health']], [['api', '..', 'health']], [['api', '.']],
    [['api', 'a/b']], [['api', 'a\\b']], [['api', '%2e%2e']], [['api', '']], [['api', 'x?y=1']], [['api', 'x#y']],
    [['api', 'webhooks', 'email', 'resend']], [['API', 'Webhooks', 'email']], [['api', 'billing', 'subscription', 'webhook']], [['api', 'ready-to-wear', 'payment-webhook']], [['api', 'a\u0000b']],
    [Array.from({ length: 13 }, () => 'api')],
  ])('refuses %j', (segs) => expect(apiPath(segs as string[] | undefined)).toBeNull());
});

describe('isSameOrigin', () => {
  it('allows a matching origin', () => expect(isSameOrigin('http://localhost:3000', 'localhost:3000')).toBe(true));
  it('is case-insensitive on the host', () => expect(isSameOrigin('https://App.Example.com', 'app.example.com')).toBe(true));
  it('refuses another site', () => expect(isSameOrigin('https://evil.example', 'app.example.com')).toBe(false));
  it('refuses a different port', () => expect(isSameOrigin('http://localhost:4000', 'localhost:3000')).toBe(false));
  it('refuses garbage', () => expect(isSameOrigin('not a url', 'localhost')).toBe(false));
  it('allows a missing origin (non-browser client)', () => expect(isSameOrigin(null, 'localhost')).toBe(true));
});

describe('clientIp: only trusted when a proxy you control sets it', () => {
  const h = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
  it('ignores the header when not trusted', () => expect(clientIp(h, false)).toBeNull());
  it('takes the rightmost entry (added by the trusted proxy), never the client-supplied one', () => expect(clientIp(h, true)).toBe('203.0.113.9'));
  it('accepts IPv6', () => expect(clientIp(new Headers({ 'x-forwarded-for': '2001:db8::1' }), true)).toBe('2001:db8::1'));
  it('rejects non-address values', () => expect(clientIp(new Headers({ 'x-forwarded-for': '1.1.1.1, <script>' }), true)).toBeNull());
  it('returns null without the header', () => expect(clientIp(new Headers(), true)).toBeNull());
});

describe('upstreamHeaders: allow-list only', () => {
  const incoming = new Headers({
    cookie: 'tailoring.session=abc', 'x-xsrf-token': 't', 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': 'order-create-123',
    authorization: 'Bearer stolen', host: 'evil', 'x-forwarded-host': 'evil', 'x-forwarded-for': '9.9.9.9',
  });
  it('forwards cookie, csrf, content-type, accept and idempotency keys', () => {
    const out = upstreamHeaders(incoming, false);
    expect(out.get('cookie')).toBe('tailoring.session=abc');
    expect(out.get('x-xsrf-token')).toBe('t');
    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('idempotency-key')).toBe('order-create-123');
  });
  it('drops authorization, host and forwarded headers', () => {
    const out = upstreamHeaders(incoming, false);
    expect(out.get('authorization')).toBeNull();
    expect(out.get('host')).toBeNull();
    expect(out.get('x-forwarded-host')).toBeNull();
    expect(out.get('x-forwarded-for')).toBeNull();
  });
  it('passes the proxy-added client address when trusted', () => expect(upstreamHeaders(incoming, true).get('x-forwarded-for')).toBe('9.9.9.9'));
});

describe('responseHeaders', () => {
  it('keeps every Set-Cookie and forbids caching', () => {
    const up = new Headers({ 'content-type': 'application/json', 'cache-control': 'public, max-age=999', server: 'Kestrel' });
    up.append('set-cookie', 'tailoring.session=1; path=/; httponly');
    up.append('set-cookie', 'tailoring.csrf=2; path=/');
    const out = responseHeaders(up);
    expect(out.getSetCookie()).toHaveLength(2);
    expect(out.get('cache-control')).toBe('no-store');
    expect(out.get('server')).toBeNull();
    expect(out.get('content-type')).toBe('application/json');
  });

  it('passes the list total headers through and nothing else the API adds', () => {
    const up = new Headers({ 'x-total-count': '1350', 'x-result-limit': '1000', 'x-truncated': 'true', 'x-powered-by': 'Express' });
    const out = responseHeaders(up);
    expect(out.get('x-total-count')).toBe('1350');
    expect(out.get('x-result-limit')).toBe('1000');
    expect(out.get('x-truncated')).toBe('true');
    expect(out.get('x-powered-by')).toBeNull();
  });
});
