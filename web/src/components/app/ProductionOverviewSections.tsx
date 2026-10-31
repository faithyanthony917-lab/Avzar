import Link from 'next/link';
import { formatDateTime } from '@/lib/dates';
import { attentionItems, dayHeading, flagLabels, formatSlotTimes, taskStatusText, type ProductionOverview, type ViewTask } from '@/lib/production-view';

function Flags({ task }: { task: ViewTask }) {
  const labels = flagLabels(task.flags);
  if (labels.length === 0) return null;
  return <ul className="ap-flags" aria-label="Warnings">{labels.map((label) => <li key={label} className="ap-badge ap-badge-off">{label}</li>)}</ul>;
}

/** Dashboard sections for managers: what needs attention now, and today's planned work by worker. */
export function ProductionOverviewSections({ overview }: { overview: ProductionOverview }) {
  const items = attentionItems(overview.attention);
  const flagged = items.reduce((sum, item) => sum + item.count, 0);
  const zone = overview.timeZoneId;
  return (
    <section className="ap-stack" aria-labelledby="prod-attention">
      <div>
        <h2 id="prod-attention" className="ap-h2">Production needs attention</h2>
        <p className="ap-foot" style={{ margin: 0 }}>
          {overview.attention.openTasks} open task{overview.attention.openTasks === 1 ? '' : 's'} in confirmed and in-production orders.
          {overview.scopedToLocations ? ' Showing your locations only.' : ''}
        </p>
      </div>
      {flagged === 0
        ? <p className="ap-panel" role="status" style={{ margin: 0 }}>Nothing needs attention right now.</p>
        : <ul className="ap-attn" aria-label="Needs attention">
            {items.map((item) => (
              <li key={item.key} className={`ap-panel${item.count > 0 ? ' ap-attn-on' : ''}`}>
                <strong className="ap-attn-count">{item.count}</strong>
                <span>{item.href && item.count > 0 ? <Link href={item.href}>{item.label}</Link> : item.label}</span>
              </li>
            ))}
          </ul>}

      <div className="ap-panel ap-stack" aria-labelledby="prod-today">
        <div className="ap-row">
          <h2 id="prod-today" className="ap-h2">Today by worker</h2>
          <span className="ap-foot">{dayHeading(overview.today)}</span>
        </div>
        {overview.todayByWorker.length === 0
          ? <p style={{ margin: 0 }}>No tasks are planned for today. Preview and publish the shop schedule to plan work.</p>
          : overview.todayByWorker.map((group) => (
            <div key={group.membershipId ?? 'unassigned'}>
              <h3 style={{ margin: '0 0 .4rem', fontSize: '1rem' }}>{group.displayName ?? (group.membershipId ? 'Unnamed worker' : 'Unassigned')}</h3>
              <div className="ap-scroll">
                <table className="ap-table">
                  <thead><tr><th scope="col">Time</th><th scope="col">Task</th><th scope="col">Order</th><th scope="col">Status</th><th scope="col">Deadline</th></tr></thead>
                  <tbody>
                    {group.tasks.map((task) => (
                      <tr key={task.taskId}>
                        <td>{formatSlotTimes(task.startUtc, task.endUtc, zone)}</td>
                        <td><Link href={`/tasks/${task.taskId}`}>{task.title}</Link><div className="ap-small ap-dim">{task.stageName}</div><Flags task={task} /></td>
                        <td>{task.orderNumber}</td>
                        <td>{taskStatusText(task.status)}</td>
                        <td>{task.deadlineUtc ? formatDateTime(task.deadlineUtc, zone) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        {overview.todayTruncated && <p className="ap-foot" role="status" style={{ margin: 0 }}>Only the first planned tasks are listed. Open the Calendar tab on Production for the full day.</p>}
        <Link href="/tasks?view=calendar" className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none', justifySelf: 'start' }}>Open calendar</Link>
      </div>
    </section>
  );
}

export function ProductionOverviewError() {
  return <section className="ap-panel" role="alert" aria-labelledby="prod-attention"><h2 id="prod-attention" className="ap-h2">Production needs attention</h2><p style={{ margin: 0 }}>The production overview could not be loaded. Reload to try again.</p></section>;
}
