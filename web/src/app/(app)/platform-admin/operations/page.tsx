import { PageHead } from '@/components/app/PageHead';
import { PlatformAdminNav } from '@/components/app/PlatformAdminNav';
import { PlatformOperations } from '@/components/app/PlatformOperations';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';

export const metadata = { title: 'Platform operations · Avzar' };
export const dynamic = 'force-dynamic';

type Flag = { key: string; description: string; enabled: boolean; updatedAtUtc: string | null; updatedByEmail: string | null };
type Job = { kind: 'notification' | 'push' | 'worker-summary' | 'appointment-reminder' | 'email'; id: string; businessId: string; eventType: string; status: string; attempts: number; nextAttemptUtc: string | null; createdAtUtc: string; lastError: string | null };

export default async function PlatformOperationsPage() {
  const me = (await getSession())!;
  const [flags, jobs] = await Promise.all([
    serverGet<{ items: Flag[] }>('/api/platform-admin/feature-flags'),
    serverGet<{ items: Job[] }>('/api/platform-admin/background-jobs?limit=250&status=Failed'),
  ]);
  const failed = [flags, jobs].find((r) => !r.ok);
  if (failed && !failed.ok) {
    if (failed.status === 401 || failed.status === 403) return <NoAccess />;
    return <LoadError status={failed.status} />;
  }
  if (!flags.ok || !jobs.ok) return <LoadError status={502} />;
  return <div className="ap-stack"><PageHead title="Platform operations" intro="Global feature controls and notification-delivery operations. Access is restricted to configured platform administrators." zone={me.timeZoneId}></PageHead><PlatformAdminNav current="/platform-admin/operations" /><PlatformOperations initialFlags={flags.data.items} initialJobs={jobs.data.items} /></div>;
}
