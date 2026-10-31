import { PageHead } from '@/components/app/PageHead';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { WorkerScheduleManager } from '@/components/app/WorkerScheduleManager';
import { LeaveCollisionsPanel, LeaveCollisionsUnavailable } from '@/components/app/LeaveCollisions';
import { getSession, serverGet } from '@/lib/session';
import type { LeaveConflictsReport } from '@/lib/worker-today';
import { can } from '@/lib/team';

export const metadata = { title: 'Worker schedules · Avzar' };
export const dynamic = 'force-dynamic';

type Worker = { membershipId: string; displayName: string; isActive: boolean; skills: string[]; openTasks: number };

export default async function WorkerSchedulesPage() {
  const me = (await getSession())!;
  if (!can(me, 'tasks.view')) return <NoAccess />;
  const [result, collisions] = await Promise.all([serverGet<Worker[]>('/api/workers'), serverGet<LeaveConflictsReport>('/api/production/leave-conflicts')]);
  if (!result.ok) return <LoadError status={result.status} />;
  return <div className="ap-stack">
    <PageHead title="Worker schedules" intro="Manage individual availability, daily workload capacity, approved leave and assigned task calendars." zone={me.timeZoneId} />
    {collisions.ok ? <LeaveCollisionsPanel report={collisions.data} timeZone={me.timeZoneId} /> : <LeaveCollisionsUnavailable />}
    <WorkerScheduleManager initialWorkers={result.data} canManage={can(me, 'workers.manage')} canRequest={can(me, 'tasks.work')} timeZoneId={me.timeZoneId} />
  </div>;
}
