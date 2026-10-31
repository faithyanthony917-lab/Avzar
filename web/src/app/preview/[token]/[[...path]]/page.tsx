import { notFound } from 'next/navigation';
import { getPreview } from '@/lib/api';
import { renderSitePage } from '@/lib/render';

export default async function PreviewPage({ params }: { params: Promise<{ token: string; path?: string[] }> }) {
  const { token, path } = await params;
  const site = await getPreview(token);
  if (!site) notFound();
  return renderSitePage(site, `/preview/${token}`, path ?? []);
}
