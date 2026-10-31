import { PageHead } from '@/components/app/PageHead';
import { PlatformAdminNav } from '@/components/app/PlatformAdminNav';
import { PlatformBusinessDetailView } from '@/components/app/PlatformBusinessDetailView';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import type { PlatformBusinessDetail } from '@/lib/platformAdmin';

export const metadata = { title: 'Business · Platform · Avzar' };
export const dynamic = 'force-dynamic';

export default async function PlatformBusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const me = (await getSession())!;
  const { id } = await params;
  const res = await serverGet<PlatformBusinessDetail>(`/api/platform-admin/businesses/${encodeURIComponent(id)}`);
  if (!res.ok) {
    if (res.status === 404) return <div className="ap-stack"><PlatformAdminNav current="/platform-admin/businesses" /><div className="ap-panel" role="alert"><p style={{ margin: 0 }}>That business was not found.</p></div></div>;
    return res.status === 401 || res.status === 403 ? <NoAccess /> : <LoadError status={res.status} />;
  }
  return (
    <div className="ap-stack">
      <PageHead title={res.data.name} intro="Opening this page is recorded in the platform audit log." zone={me.timeZoneId} back={<a href="/platform-admin/businesses">All businesses</a>} />
      <PlatformAdminNav current="/platform-admin/businesses" />
      <PlatformBusinessDetailView business={res.data} />
    </div>
  );
}
