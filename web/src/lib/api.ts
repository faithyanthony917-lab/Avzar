import type { Collection, DesignDetail, DesignSummary, Paged, Site } from './types';

const API = process.env.API_URL ?? 'http://localhost:8080';
const MEDIA = process.env.NEXT_PUBLIC_API_PUBLIC_URL ?? API;

/** Browser-reachable URL of a public image. Only images of the live published site (or public designs) resolve. */
export function mediaUrl(id: string | null | undefined, variant: 'sm' | 'md' | 'orig' = 'md'): string | null {
  return id ? `${MEDIA}/public/media/${encodeURIComponent(id)}/${variant}` : null;
}

async function get<T>(path: string, revalidate: number | false): Promise<T | null> {
  const res = await fetch(`${API}${path}`, revalidate === false ? { cache: 'no-store' } : { next: { revalidate } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const getSite = (slug: string) => get<Site>(`/public/sites/${enc(slug)}`, 30);
export const getPreview = (token: string) => get<Site>(`/public/preview/${enc(token)}`, false);

export const getDesigns = (slug: string, q: { categoryId?: string; featured?: boolean; pageSize?: number; search?: string } = {}) => {
  const p = new URLSearchParams();
  if (q.categoryId) p.set('categoryId', q.categoryId);
  if (q.featured !== undefined) p.set('featured', String(q.featured));
  if (q.search) p.set('search', q.search);
  p.set('pageSize', String(q.pageSize ?? 24));
  return get<Paged<DesignSummary>>(`/public/sites/${enc(slug)}/designs?${p}`, 30);
};

export const getDesign = (slug: string, designSlug: string) => get<DesignDetail>(`/public/sites/${enc(slug)}/designs/${enc(designSlug)}`, 30);
export const getCollection = (slug: string, collectionSlug: string) => get<Collection>(`/public/sites/${enc(slug)}/collections/${enc(collectionSlug)}`, 30);
export const getSitemap = (slug: string, baseUrl: string) =>
  fetch(`${API}/public/sites/${enc(slug)}/sitemap.xml?baseUrl=${enc(baseUrl)}`, { next: { revalidate: 300 } });
export const getRobots = (slug: string, baseUrl: string) =>
  fetch(`${API}/public/sites/${enc(slug)}/robots.txt?baseUrl=${enc(baseUrl)}`, { next: { revalidate: 300 } });
