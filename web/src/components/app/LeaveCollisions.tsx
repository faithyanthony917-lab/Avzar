import Link from 'next/link';
import { formatSlotTimes, taskStatusText } from '@/lib/production-view';
import { collidingLeaves, collisionLabel, formatLeaveRange, leaveStatusText, type LeaveConflict, type LeaveConflictsReport } from '@/lib/worker-today';

const TASKS_SHOWN = 5;

function TaskLinks({ conflict, timeZone }: { conflict: LeaveConflict; timeZone: string }) {
  const shown = conflict.affectedTasks.slice(0, TASKS_SHOWN);
  const more = conflict.affectedTaskCount - shown.length;
  return (
    <ul className="ap-flags" aria-label="Affected tasks" style={{ display: 'block' }}>
      {shown.map((task) => (
        <li key={task.taskId} className="ap-small">
          <Link href={`/tasks/${task.taskId}`}>{task.title}</Link> · {task.orderNumber} · {taskStatusText(task.status)} · {formatSlotTimes(task.startUtc, task.endUtc, timeZone)}
        </li>
      ))}
      {more > 0 && <li className="ap-small ap-dim">and {more}{conflict.affectedTasksTruncated ? '+' : ''} more</li>}
    </ul>
  );
}

/** A short note under a leave row: how many planned tasks it collides with. Renders nothing when there is no collision. */
export function LeaveCollisionBadge({ conflict, timeZone }: { conflict: LeaveConflict | undefined; timeZone: string }) {
  if (!conflict || conflict.affectedTaskCount === 0) return null;
  return <div className="ap-small" role="note"><strong>{collisionLabel(conflict)}</strong><TaskLinks conflict={conflict} timeZone={timeZone} /></div>;
}

/** Page-level panel on the worker schedule page: every leave that collides with planned work, pending first. */
export function LeaveCollisionsPanel({ report, timeZone }: { report: LeaveConflictsReport; timeZone: string }) {
  const leaves = collidingLeaves(report);
  return (
    <section id="leave-collisions" className="ap-panel ap-stack" aria-labelledby="leave-collisions-title">
      <h2 id="leave-collisions-title" className="ap-h2">Leave collisions</h2>
      {report.scopedToLocations && <p className="ap-foot" style={{ margin: 0 }}>Showing workers in your locations only.</p>}
      {leaves.length === 0
        ? <p role="status" style={{ margin: 0 }}>No pending or approved leave collides with planned tasks.</p>
        : <>
            <p className="ap-foot" style={{ margin: 0 }}>These leave periods overlap work that is already planned. Approving leave does not move the work: preview and publish the shop schedule to re-plan it.</p>
            <ul className="ap-agenda">
              {leaves.map((leave) => (
                <li key={leave.leaveId}>
                  <div className="ap-agenda-time">{leaveStatusText(leave.status)}</div>
                  <div>
                    <strong>{leave.workerName ?? 'Unnamed worker'}</strong> · {formatLeaveRange(leave.startsAtUtc, leave.endsAtUtc, timeZone)}
                    <div className="ap-small ap-dim">{leave.reason}</div>
                    <LeaveCollisionBadge conflict={leave} timeZone={timeZone} />
                  </div>
                </li>
              ))}
            </ul>
            <Link href="/tasks/schedule" className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none', justifySelf: 'start' }}>Open shop schedule</Link>
          </>}
    </section>
  );
}

export function LeaveCollisionsUnavailable() {
  return <p className="ap-foot" role="status" style={{ margin: 0 }}>Leave collisions could not be loaded. Reload to try again; approving and rejecting leave still works.</p>;
}
