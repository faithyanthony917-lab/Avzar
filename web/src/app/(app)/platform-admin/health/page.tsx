import { PageHead } from '@/components/app/PageHead';
import { PlatformAdminNav } from '@/components/app/PlatformAdminNav';
import { PlatformHealthReport } from '@/components/app/PlatformHealthReport';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import type { PlatformHealth } from '@/lib/platformAdmin';

export const metadata = { title: 'Health · Platform · Avzar' };
export const dynamic = 'force-dynamic';

export default async function PlatformHealthPage() {
  const me = (await getSession())!;
  const res = await serverGet<PlatformHealth>('/api/platform-admin/health');
  if (!res.ok) return res.status === 401 || res.status === 403 ? <NoAccess /> : <LoadError status={res.status} />;
  return (
    <div className="ap-stack">
      <PageHead title="Platform health" intro="Reload the page to check again." zone={me.timeZoneId} />
      <PlatformAdminNav current="/platform-admin/health" />
      <PlatformHealthReport report={res.data} />
    </div>
  );
}
