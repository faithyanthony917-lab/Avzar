import { NextResponse, type NextRequest } from 'next/server';
import { clientIp } from '@/lib/proxy';

const API = process.env.API_URL ?? 'http://localhost:8080';

/** Set TRUST_PROXY_HEADERS=true only behind a reverse proxy you control; otherwise no client address is forwarded. */
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

/**
 * Forwards a visitor's request to the API. The API rate-limits per client address, so the visitor's address is passed on
 * in X-Forwarded-For, but only the rightmost entry set by the trusted proxy (see clientIp), never a client-supplied value.
 * The API must run with Proxy__TrustForwardedHeaders=true and be reachable ONLY through this server.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return NextResponse.json({ code: 'site_not_found' }, { status: 404 });

  let payload: unknown;
  try { payload = await req.json(); } catch { return NextResponse.json({ code: 'invalid_request' }, { status: 400 }); }
  if (JSON.stringify(payload).length > 8000) return NextResponse.json({ code: 'invalid_request' }, { status: 413 });

  const ip = clientIp(req.headers, TRUST_PROXY);
  const upstream = await fetch(`${API}/public/sites/${slug}/inquiries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
    body: JSON.stringify(payload),
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) return NextResponse.json({ code: 'unavailable' }, { status: 502 });
  const body = await upstream.json().catch(() => ({}));
  return NextResponse.json(body, { status: upstream.status });
}
