import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDesign, getSite, mediaUrl } from '@/lib/api';
import { DesignPageView, loadDesign, siteMetadata } from '@/lib/render';

type Props = { params: Promise<{ slug: string; designSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, designSlug } = await params;
  const [site, design] = await Promise.all([getSite(slug), getDesign(slug, designSlug)]);
  if (!site || !design) return {};
  return siteMetadata(site, null, `${design.name} | ${site.name}`, design.description ?? undefined, mediaUrl(design.images[0]?.mediaId, 'md'));
}

export default async function DesignPage({ params }: Props) {
  const { slug, designSlug } = await params;
  const site = await getSite(slug);
  if (!site) notFound();
  const base = (await headers()).get('x-site-root') ? '' : `/sites/${slug}`;
  return <DesignPageView site={site} base={base} design={await loadDesign(site, designSlug)} />;
}
