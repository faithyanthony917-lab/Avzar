import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHead } from '@/components/app/PageHead';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { TaskActions } from '@/components/app/TaskActions';
import { TaskMaterials } from '@/components/app/TaskMaterials';
import { TaskProgressPhotos } from '@/components/app/TaskProgressPhotos';
import { formatDateTime } from '@/lib/dates';
import type { TaskDetail, WorkerOption } from '@/lib/production-types';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';
import { canManageTaskMaterials } from '@/lib/task-materials';

export const metadata = { title: 'Production task · Avzar' };
export const dynamic = 'force-dynamic';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GUID.test(id)) notFound();
  const me = (await getSession())!;
  const manager = can(me, 'tasks.view');
  const worker = !manager && can(me, 'tasks.work');
  if (!manager && !worker) return <NoAccess />;
  const result = await serverGet<TaskDetail>(`${manager ? '/api/tasks' : '/api/my/tasks'}/${id}`);
  if (!result.ok) { if (result.status === 404) notFound(); return <LoadError status={result.status} />; }
  const detail = result.data;
  const t = detail.task;
  let workers: WorkerOption[] = [];
  if (manager && can(me, 'tasks.assign')) {
    const roster = await serverGet<WorkerOption[]>('/api/workers');
    if (roster.ok) workers = roster.data;
  }
  const date = (iso: string | null) => iso ? formatDateTime(iso, me.timeZoneId) : 'Not set';

  return <>
    <PageHead title={t.title} zone={me.timeZoneId} back={<Link href="/tasks">← Production</Link>} />
    <div className="ap-stack">
      <section className="ap-panel" aria-labelledby="task-overview">
        <h2 id="task-overview" className="ap-h2">Task overview</h2>
        <dl className="ap-dl">
          <dt>Status</dt><dd>{t.status}{t.isOverdue ? ' · Overdue' : ''}</dd>
          <dt>Order</dt><dd><Link href={`/orders/${t.orderId}`}>{t.orderNumber}</Link></dd>
          <dt>Garment</dt><dd>{detail.garment.name} · Quantity {detail.garment.quantity}</dd>
          <dt>Stage</dt><dd>{t.stageName}</dd>
          <dt>Priority</dt><dd>{t.priority}</dd>
          <dt>Assignee</dt><dd>{t.assigneeName ?? 'Unassigned'}</dd>
          <dt>Deadline</dt><dd>{date(t.deadlineUtc)}</dd>
          <dt>Planned start</dt><dd>{date(detail.plannedStartUtc)}</dd>
          <dt>Planned end</dt><dd>{date(detail.plannedEndUtc)}</dd>
          <dt>Actual start</dt><dd>{date(detail.actualStartUtc)}</dd>
          <dt>Completed</dt><dd>{date(detail.completedAtUtc)}</dd>
          {manager && detail.customerName && <><dt>Customer</dt><dd>{detail.customerName}</dd></>}
          {t.requiredSkill && <><dt>Required skill</dt><dd>{t.requiredSkill}</dd></>}
          {t.estimatedMinutes != null && <><dt>Estimate</dt><dd>{t.estimatedMinutes} minutes</dd></>}
        </dl>
        {(detail.instructions || detail.garment.styleInstructions || detail.garment.alterationNotes) && <div className="ap-stack" style={{ marginTop: '1rem' }}>
          {detail.instructions && <div><h3 className="ap-h3">Work instructions</h3><p className="ap-pre">{detail.instructions}</p></div>}
          {detail.garment.styleInstructions && <div><h3 className="ap-h3">Style instructions</h3><p className="ap-pre">{detail.garment.styleInstructions}</p></div>}
          {detail.garment.alterationNotes && <div><h3 className="ap-h3">Alteration notes</h3><p className="ap-pre">{detail.garment.alterationNotes}</p></div>}
        </div>}
        {t.blockedReason && <p className="ap-alert" role="status">Blocked: {t.blockedReason}</p>}
        {!t.isEligible && (t.status === 'Pending' || t.status === 'Scheduled') && <p className="ap-foot">This task cannot start until its prerequisites are complete and the order is active.</p>}
      </section>

      {detail.dependsOn.length > 0 && <section className="ap-panel" aria-labelledby="task-deps"><h2 id="task-deps" className="ap-h2">Prerequisites</h2><ul>{detail.dependsOn.map((d) => <li key={d.taskId}>{d.title} — {d.status}</li>)}</ul></section>}
      {(detail.requiredChecks.length > 0 || detail.requiredMaterials.length > 0) && <section className="ap-panel" aria-labelledby="task-requirements"><h2 id="task-requirements" className="ap-h2">Requirements</h2>{detail.requiredChecks.length > 0 && <><h3 className="ap-h3">Completion checklist</h3><ul>{detail.requiredChecks.map((c) => <li key={c}>{c}{detail.completedChecks.includes(c) ? ' ✓' : ''}</li>)}</ul></>}{detail.requiredMaterials.length > 0 && <><h3 className="ap-h3">Materials</h3><ul>{detail.requiredMaterials.map((m, i) => <li key={`${m.name}-${i}`}>{m.name}: {m.quantity} {m.unit}</li>)}</ul></>}</section>}
      <TaskActions detail={detail} isWorker={worker} canAssign={manager && can(me, 'tasks.assign')} canManage={manager && can(me, 'tasks.manage')} canOverride={manager && can(me, 'tasks.override')} workers={workers} />
      <TaskProgressPhotos taskId={t.id} workerOnly={worker} />
      {canManageTaskMaterials(t.status, can(me, 'inventory.manage'), can(me, 'inventory.view')) && <TaskMaterials taskId={t.id} />}
      <section className="ap-panel" aria-labelledby="task-events"><h2 id="task-events" className="ap-h2">Task history</h2>{detail.events.length === 0 ? <p style={{ margin: 0 }}>No history entries.</p> : <ol className="ap-log">{detail.events.map((event, i) => <li key={`${event.atUtc}-${event.type}-${i}`}><strong>{event.type}</strong>{event.fromStatus || event.toStatus ? <div className="ap-small">{event.fromStatus ?? '—'} → {event.toStatus ?? '—'}</div> : null}{event.note && <p className="ap-pre" style={{ margin: '.25rem 0' }}>{event.note}</p>}<div className="ap-small ap-dim">{formatDateTime(event.atUtc, me.timeZoneId)}</div></li>)}</ol>}</section>
    </div>
  </>;
}
