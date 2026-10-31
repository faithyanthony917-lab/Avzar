import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getSite } from '@/lib/api';
import { findPage, renderSitePage, siteMetadata } from '@/lib/render';

type Props = { params: Promise<{ slug: string; path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, path } = await params;
  const site = await getSite(slug);
  return site ? siteMetadata(site, findPage(site, path ?? [])) : {};
}

export default async function SitePage({ params }: Props) {
  const { slug, path } = await params;
  const site = await getSite(slug);
  if (!site) notFound();
  const base = (await headers()).get('x-site-root') ? '' : `/sites/${slug}`;
  return renderSitePage(site, base, path ?? []);
}
