import { notFound } from 'next/navigation';
import SiteShell from '@/components/SiteShell';
import { getPreview } from '@/lib/api';

export const metadata = { robots: { index: false, follow: false } };

export default async function PreviewLayout({ children, params }: { children: React.ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  const site = await getPreview(token);
  if (!site) notFound();
  return <SiteShell site={site} base={`/preview/${token}`}>{children}</SiteShell>;
}
