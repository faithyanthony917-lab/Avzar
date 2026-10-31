import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import SiteShell from '@/components/SiteShell';
import { getSite } from '@/lib/api';

export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = await getSite(slug);
  if (!site) notFound();
  const base = (await headers()).get('x-site-root') ? '' : `/sites/${slug}`;
  return <SiteShell site={site} base={base}>{children}</SiteShell>;
}
