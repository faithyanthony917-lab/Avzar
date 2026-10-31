import Link from 'next/link';
import { formatDateTime } from '@/lib/dates';
import { taskStatusText, formatSlotTimes } from '@/lib/production-view';
import { formatLeaveRange, leaveStatusText, type MyToday } from '@/lib/worker-today';

/** The worker's own planned work for today and their own leave. Read-only; each task links to the existing task page. */
export function WorkerTodayPanel({ data }: { data: MyToday }) {
  const zone = data.timeZoneId;
  const upcoming = data.leave;
  return (
    <div className="ap-stack">
      {data.onLeaveToday && <p className="ap-panel" role="status" style={{ margin: 0 }}><strong>You are on approved leave today.</strong> Your manager can still see work planned for today and may move it.</p>}
      <section className="ap-panel ap-stack" aria-labelledby="my-today">
        <h2 id="my-today" className="ap-h2">Planned for today</h2>
        {data.tasks.length === 0
          ? <p style={{ margin: 0 }}>{data.onLeaveToday ? 'Nothing is planned for you today.' : 'Nothing is planned for you today. Check Open tasks for work that is not scheduled yet.'}</p>
          : <ul className="ap-agenda">
              {data.tasks.map((task) => (
                <li key={task.taskId}>
                  <div className="ap-agenda-time">{formatSlotTimes(task.startUtc, task.endUtc, zone)}</div>
                  <div>
                    <Link href={`/tasks/${task.taskId}`}><strong>{task.title}</strong></Link>
                    <div className="ap-small ap-dim">{task.orderNumber} · {task.stageName} · {taskStatusText(task.status)}{task.priority && task.priority !== 'Normal' ? ` · ${task.priority} priority` : ''}</div>
                    {task.deadlineUtc && <div className="ap-small ap-dim">Deadline {formatDateTime(task.deadlineUtc, zone)}</div>}
                  </div>
                </li>
              ))}
            </ul>}
        {data.tasksTruncated && <p className="ap-foot" role="status" style={{ margin: 0 }}>Only the first tasks are listed. Open tasks shows the rest.</p>}
      </section>
      {upcoming.length > 0 && (
        <section className="ap-panel ap-stack" aria-labelledby="my-leave">
          <h2 id="my-leave" className="ap-h2">Your leave</h2>
          <ul className="ap-agenda">
            {upcoming.map((item) => (
              <li key={item.leaveId}>
                <div className="ap-agenda-time">{leaveStatusText(item.status)}</div>
                <div>{formatLeaveRange(item.startsAtUtc, item.endsAtUtc, zone)}<div className="ap-small ap-dim">{item.reason}</div></div>
              </li>
            ))}
          </ul>
          <p className="ap-foot" style={{ margin: 0 }}>Shows leave in the next 14 days. Request leave on the worker schedule page.</p>
        </section>
      )}
    </div>
  );
}
