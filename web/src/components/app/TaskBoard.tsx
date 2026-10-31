import Link from 'next/link';
import { formatDateTime } from '@/lib/dates';
import { taskNeedsAttention } from '@/lib/production';
import type { TaskSummary } from '@/lib/production-types';
import { BOARD_COLUMN_SIZE, taskStatusText } from '@/lib/production-view';

export interface BoardColumn { status: string; total: number; items: TaskSummary[]; failed: boolean }

/** Read-only board: one column per task status, the first tasks of each, with a link to the filtered list. */
export function TaskBoard({ columns, timeZoneId }: { columns: BoardColumn[]; timeZoneId: string }) {
  return (
    <div className="ap-board">
      {columns.map((column) => (
        <section key={column.status} className="ap-panel ap-stack" aria-labelledby={`board-${column.status}`}>
          <h2 id={`board-${column.status}`} className="ap-h2">{taskStatusText(column.status)}<span className="ap-badge">{column.failed ? '?' : column.total}</span></h2>
          {column.failed
            ? <p role="alert" style={{ margin: 0 }}>This column could not be loaded. Reload to try again.</p>
            : column.items.length === 0
              ? <p className="ap-foot" style={{ margin: 0 }}>No {taskStatusText(column.status).toLowerCase()} tasks.</p>
              : <ul className="ap-board-list">
                  {column.items.map((task) => (
                    <li key={task.id} className={`ap-board-card${taskNeedsAttention(task) ? ' ap-task-attention-card' : ''}`}>
                      <Link href={`/tasks/${task.id}`}><strong>{task.title}</strong></Link>
                      <div className="ap-small ap-dim">{task.orderNumber} · {task.garmentName}</div>
                      <div className="ap-small">{task.assigneeName ?? 'Unassigned'}{task.priority && task.priority !== 'Normal' ? ` · ${task.priority} priority` : ''}</div>
                      <div className="ap-small ap-dim">Deadline {task.deadlineUtc ? formatDateTime(task.deadlineUtc, timeZoneId) : '—'}{task.isOverdue ? ' · Overdue' : ''}</div>
                    </li>
                  ))}
                </ul>}
          {!column.failed && column.total > column.items.length && <p className="ap-foot" style={{ margin: 0 }}>Showing {Math.min(BOARD_COLUMN_SIZE, column.items.length)} of {column.total}. <Link href={`/tasks?status=${column.status}`}>View all</Link></p>}
        </section>
      ))}
    </div>
  );
}
