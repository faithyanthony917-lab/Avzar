import type { NextRequest } from 'next/server';
import { apiPath, isSameOrigin, responseHeaders, upstreamHeaders } from '@/lib/proxy';

/**
 * Same-origin proxy to the API for the browser. The Content-Security-Policy only allows connect-src 'self', and the session
 * cookie must belong to this origin, so the dashboard talks to /backend/api/** and this handler forwards to API_URL at runtime.
 * Only /api/** is forwarded (never /public, /health or webhooks).
 */
export const dynamic = 'force-dynamic';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
/** Set TRUST_PROXY_HEADERS=true only when a reverse proxy you control (Caddy, Render, Fly) sets X-Forwarded-For in front of this app. */
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const json = (status: number, title: string) =>
  new Response(JSON.stringify({ status, title }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const upstreamPath = apiPath(path);
  if (!upstreamPath) return json(404, 'Not found');

  const unsafe = req.method !== 'GET' && req.method !== 'HEAD';
  if (unsafe && !isSameOrigin(req.headers.get('origin'), req.headers.get('host'))) return json(403, 'Cross-origin request refused.');

  try {
    const upstream = await fetch(`${API}/${upstreamPath}${req.nextUrl.search}`, {
      method: req.method,
      headers: upstreamHeaders(req.headers, TRUST_PROXY),
      body: unsafe ? req.body : undefined,
      redirect: 'manual',
      cache: 'no-store',
      // Node's fetch needs this to stream a request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders(upstream.headers) });
  } catch {
    return json(502, 'The service is temporarily unavailable. Try again in a moment.');
  }
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
