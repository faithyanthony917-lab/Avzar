import { getRobots } from '@/lib/api';

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const host = req.headers.get('host') ?? '';
  const res = await getRobots(slug, `https://${host}`);
  if (!res.ok) return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
  return new Response(await res.text(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
