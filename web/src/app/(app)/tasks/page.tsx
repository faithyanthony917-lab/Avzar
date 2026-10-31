import { PageHead } from '@/components/app/PageHead';
import Link from 'next/link';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { formatDateTime } from '@/lib/dates';
import { getSession, serverGet } from '@/lib/session';
import type { Paged } from '@/lib/customer-types';
import type { TaskSummary, WorkerOption } from '@/lib/production-types';
import { TaskQuickAssign } from '@/components/app/TaskQuickAssign';
import { can } from '@/lib/team';
import { ProductionViewTabs } from '@/components/app/ProductionViewTabs';
import { parseViewQuery } from '@/lib/production-view';
import { WORKER_TABS, parseWorkerShow, type MyToday } from '@/lib/worker-today';
import { WorkerTodayPanel } from '@/components/app/WorkerTodayPanel';
import { productionViewScreen } from './productionViewScreen';
import { managerTaskApiQuery, managerTaskListHref, parseManagerTaskQuery, taskNeedsAttention, taskPageCount, taskStatusLabel, taskStatusTone, TASK_STATUSES, workerTaskApiQuery, type TaskShow } from '@/lib/production';

export const metadata = { title: 'Production · Avzar' };
export const dynamic = 'force-dynamic';

function Status({ value }: { value: string }) {
  const tone = taskStatusTone(value);
  return <span className={`ap-badge${tone === 'on' ? ' ap-badge-on' : tone === 'off' ? ' ap-badge-off' : ''}`} style={{ marginLeft: 0 }}>{taskStatusLabel(value)}</span>;
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = (await getSession())!;
  const manager = can(me, 'tasks.view');
  const worker = can(me, 'tasks.work');
  if (!manager && !worker) return <NoAccess />;
  const params = await searchParams;

  if (!manager && worker) {
    const workerShow = parseWorkerShow(params.show);
    if (workerShow === 'today') {
      const today = await serverGet<MyToday>('/api/my/today');
      if (!today.ok) return <LoadError status={today.status} />;
      return <>
        <PageHead title="My production tasks" intro="The work assigned to you." zone={me.timeZoneId} />
        <nav className="ap-tabs" aria-label="Task view">
          {WORKER_TABS.map((tab) => <Link key={tab.show} href={tab.href} aria-current={tab.show === 'today' ? 'page' : undefined}>{tab.label}</Link>)}
        </nav>
        <WorkerTodayPanel data={today.data} />
      </>;
    }
    const show: TaskShow = workerShow;
    const rawPage = Array.isArray(params.page) ? params.page[0] : params.page;
    const page = /^\d{1,5}$/.test(rawPage ?? '') && Number(rawPage) >= 1 && Number(rawPage) <= 10000 ? Number(rawPage) : 1;
    const result = await serverGet<Paged<TaskSummary>>(`/api/my/tasks?${workerTaskApiQuery(show, page)}`);
    if (!result.ok) return <LoadError status={result.status} />;
    const { items, totalCount, pageSize } = result.data;
    const pages = taskPageCount(totalCount, pageSize || 25);
    return <>
      <PageHead title="My production tasks" intro="The work assigned to you." zone={me.timeZoneId} />
      <nav className="ap-tabs" aria-label="Task view">
        {WORKER_TABS.map((tab) => <Link key={tab.show} href={tab.href} aria-current={show === tab.show ? 'page' : undefined}>{tab.label}</Link>)}
      </nav>
      <section className="ap-panel" aria-label="My tasks">
        {items.length === 0 ? <p style={{ margin: 0 }}>{show === 'completed' ? 'No completed tasks yet.' : show === 'all' ? 'No tasks have been assigned to you.' : 'No open tasks assigned to you. You are up to date.'}</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Task</th><th>Order</th><th>Stage</th><th>Status</th><th>Deadline</th><th>Priority</th></tr></thead><tbody>{items.map((t) => <tr key={t.id} className={taskNeedsAttention(t) ? 'ap-task-attention' : undefined}><td><Link href={`/tasks/${t.id}`}><strong>{t.title}</strong></Link><div className="ap-small ap-dim">{t.garmentName} · Qty {t.quantity}</div>{t.blockedReason && <div className="ap-small">Blocked: {t.blockedReason}</div>}</td><td>{t.orderNumber}</td><td>{t.stageName}</td><td><Status value={t.status} />{t.unmetDependencies > 0 && <div className="ap-small">{t.unmetDependencies} prerequisite(s) remain</div>}</td><td>{t.deadlineUtc ? formatDateTime(t.deadlineUtc, me.timeZoneId) : 'Not set'}{t.isOverdue && <div><span className="ap-badge ap-badge-off" style={{ marginLeft: 0 }}>Overdue</span></div>}</td><td>{t.priority}</td></tr>)}</tbody></table></div>}
        {totalCount > 0 && <div className="ap-row ap-pager"><span className="ap-hint">{totalCount} task{totalCount === 1 ? '' : 's'} · page {page} of {pages}</span><span className="ap-actions">{page > 1 && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={`/tasks?show=${show === 'open' ? 'open' : show}&page=${page - 1}`} rel="prev">Previous</Link>}{page < pages && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={`/tasks?show=${show}&page=${page + 1}`} rel="next">Next</Link>}</span></div>}
      </section>
      <p className="ap-foot" style={{ marginTop: '.75rem' }}>Task updates are not available in this first production-dashboard increment. This view is read-only; the API remains the authority for assignment and workflow rules.</p>
    </>;
  }

  const viewQuery = parseViewQuery(params);
  if (viewQuery.view !== 'list') return await productionViewScreen(viewQuery, me.timeZoneId);

  const query = parseManagerTaskQuery(params);
  const result = await serverGet<Paged<TaskSummary>>(`/api/tasks?${managerTaskApiQuery(query)}`);
  if (!result.ok) return <LoadError status={result.status} />;
  const { items, totalCount, pageSize } = result.data;
  const pages = taskPageCount(totalCount, pageSize || 25);
  const filtered = !!(query.status || query.stage || query.overdue);
  let workers: WorkerOption[] = [];
  const canAssign = can(me, 'tasks.assign');
  if (canAssign) {
    const roster = await serverGet<WorkerOption[]>('/api/workers');
    if (roster.ok) workers = roster.data;
  }
  return <>
    <PageHead title="Production" intro="Tasks, workload and team availability across the shop." zone={me.timeZoneId}><span className="ap-foot">Manager view</span>{can(me, 'tasks.manage') && <Link className="ap-btn ap-btn-quiet" href="/tasks/requests">Worker requests</Link>}{can(me, 'workflows.manage') && <Link className="ap-btn ap-btn-quiet" href="/workflows">Task templates</Link>}</PageHead>
    <ProductionViewTabs active="list" />
    <form method="get" action="/tasks" className="ap-panel ap-filter" role="search">
      <label className="ap-sr" htmlFor="task-status">Status</label><select id="task-status" name="status" className="ap-input" defaultValue={query.status}><option value="">All statuses</option>{TASK_STATUSES.map((s) => <option key={s} value={s}>{taskStatusLabel(s)}</option>)}</select>
      <label className="ap-sr" htmlFor="task-stage">Production stage</label><input id="task-stage" name="stage" className="ap-input" placeholder="Filter by stage" maxLength={80} defaultValue={query.stage} />
      <label className="ap-check"><input type="checkbox" name="overdue" value="true" defaultChecked={query.overdue} /> Overdue only</label>
      <button className="ap-btn" type="submit">Apply</button>{filtered && <Link href="/tasks" className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Clear</Link>}
    </form>
    <section className="ap-panel" style={{ marginTop: '1rem' }} aria-label="Production task list">
      {items.length === 0 ? <p style={{ margin: 0 }}>{filtered ? 'No production tasks match these filters.' : 'No production tasks yet. Confirm an order to generate its production tasks, or review the workflow configuration.'}</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Task</th><th>Order / garment</th><th>Stage</th><th>Status</th><th>Assignee</th><th>Deadline</th><th>Priority</th></tr></thead><tbody>{items.map((t) => <tr key={t.id} className={taskNeedsAttention(t) ? 'ap-task-attention' : undefined}><td><Link href={`/tasks/${t.id}`}><strong>{t.title}</strong></Link><div className="ap-small ap-dim">{t.requiredSkill ? `Skill: ${t.requiredSkill}` : 'No specific skill required'}{t.needsEstimate ? ' · Estimate needed' : ''}</div>{t.blockedReason && <div className="ap-small">{t.blockedReason}</div>}</td><td><Link href={`/orders/${t.orderId}`}>{t.orderNumber}</Link><div className="ap-small ap-dim">{t.garmentName} · Qty {t.quantity}</div></td><td>{t.stageName}</td><td><Status value={t.status} />{t.unmetDependencies > 0 && <div className="ap-small">{t.unmetDependencies} prerequisite(s)</div>}{!t.isEligible && t.status !== 'Completed' && t.status !== 'Cancelled' && <div className="ap-small">Not yet eligible</div>}</td><td>{canAssign && workers.length > 0 && t.status !== 'Completed' && t.status !== 'Cancelled' ? <TaskQuickAssign taskId={t.id} assigneeMembershipId={t.assigneeMembershipId} workers={workers} /> : (t.assigneeName ?? <span className="ap-dim">Unassigned</span>)}</td><td>{t.deadlineUtc ? formatDateTime(t.deadlineUtc, me.timeZoneId) : 'Not set'}{t.isOverdue && <div><span className="ap-badge ap-badge-off" style={{ marginLeft: 0 }}>Overdue</span></div>}</td><td>{t.priority}</td></tr>)}</tbody></table></div>}
      {totalCount > 0 && <div className="ap-row ap-pager"><span className="ap-hint">{totalCount} task{totalCount === 1 ? '' : 's'} · page {query.page} of {pages}</span><span className="ap-actions">{query.page > 1 && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={managerTaskListHref(query, { page: query.page - 1 })} rel="prev">Previous</Link>}{query.page < pages && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={managerTaskListHref(query, { page: query.page + 1 })} rel="next">Next</Link>}</span></div>}
    </section>
    <p className="ap-foot" style={{ marginTop: '.75rem' }}>This first production-dashboard increment provides live task visibility and filters. Assignment, scheduling and worker status actions remain follow-up work; all access and workflow enforcement stays on the API.</p>
  </>;
}
