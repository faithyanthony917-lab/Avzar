import { PageHead } from '@/components/app/PageHead';
import { PlatformAdminNav } from '@/components/app/PlatformAdminNav';
import { PlatformBusinessList } from '@/components/app/PlatformBusinessList';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import type { PlatformBusinessPage } from '@/lib/platformAdmin';

export const metadata = { title: 'Businesses · Platform · Avzar' };
export const dynamic = 'force-dynamic';

export default async function PlatformBusinessesPage({ searchParams }: { searchParams: Promise<{ q?: string; before?: string }> }) {
  const me = (await getSession())!;
  const { q = '', before = '' } = await searchParams;
  const query = new URLSearchParams({ limit: '25', ...(q.trim() ? { q: q.trim().slice(0, 100) } : {}), ...(before ? { before } : {}) });
  const res = await serverGet<PlatformBusinessPage>(`/api/platform-admin/businesses?${query.toString()}`);
  if (!res.ok) return res.status === 401 || res.status === 403 ? <NoAccess /> : <LoadError status={res.status} />;
  return (
    <div className="ap-stack">
      <PageHead title="Businesses" intro="Every business on the platform. Counts only, never customer details." zone={me.timeZoneId} />
      <PlatformAdminNav current="/platform-admin/businesses" />
      <PlatformBusinessList page={res.data} q={q.trim()} />
    </div>
  );
}
