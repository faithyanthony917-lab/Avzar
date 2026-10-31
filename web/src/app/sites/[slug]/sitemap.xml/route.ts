import { getSitemap } from '@/lib/api';

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const host = req.headers.get('host') ?? '';
  const res = await getSitemap(slug, `https://${host}`);
  if (!res.ok) return new Response('Not found', { status: 404 });
  return new Response(await res.text(), { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
