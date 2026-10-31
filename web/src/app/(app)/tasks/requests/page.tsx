import { PageHead } from '@/components/app/PageHead';
import Link from 'next/link';
import { NoAccess, LoadError } from '@/components/app/Notices';
import { TaskWorkerRequests } from '@/components/app/TaskWorkerRequests';
import { can } from '@/lib/team';
import { getSession, serverGet } from '@/lib/session';

type WorkerRequest = {
  id: string; taskId: string; type: 'Assistance' | 'Reassignment' | 'Discrepancy'; status: 'Pending' | 'Accepted' | 'Declined';
  message: string; plannedMinutes: number | null; actualMinutes: number | null; createdAtUtc: string;
  reviewNote: string | null; reviewedAtUtc: string | null; taskTitle: string; taskStatus: string; orderNumber: string; requestedByName: string;
};
export const metadata = { title: 'Worker requests · Avzar' };
export const dynamic = 'force-dynamic';
export default async function WorkerRequestsPage() {
  const me = (await getSession())!;
  if (!can(me, 'tasks.manage')) return <NoAccess />;
  const result = await serverGet<WorkerRequest[]>('/api/tasks/worker-requests?status=Pending');
  if (!result.ok) return <LoadError status={result.status} />;
  return <div className="ap-stack"><PageHead title="Worker requests" intro="Requests for help, reassignment or time corrections from your workers." zone={me.timeZoneId}><Link className="ap-btn ap-btn-quiet" href="/tasks">Back to production</Link></PageHead><TaskWorkerRequests initial={result.data} /></div>;
}
