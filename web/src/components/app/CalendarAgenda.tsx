import Link from 'next/link';
import { dayHeading, flagLabels, formatSlotTimes, groupSlotsByDay, taskStatusText, type CalendarReport } from '@/lib/production-view';

export const CALENDAR_SLOT_LIMIT = 500;

/** Shop-wide planned slots as a read-only agenda, one block per business-local day. */
export function CalendarAgenda({ report }: { report: CalendarReport }) {
  const days = groupSlotsByDay(report.slots, report.fromDate, report.days, report.timeZoneId);
  return (
    <div className="ap-stack">
      {report.scopedToLocations && <p className="ap-foot" style={{ margin: 0 }}>Showing tasks in your locations only.</p>}
      {report.truncated && <p className="ap-panel" role="status" style={{ margin: 0 }}>The list is cut off at {CALENDAR_SLOT_LIMIT} planned tasks. Choose a shorter range to see the rest.</p>}
      {report.slots.length === 0 && <p className="ap-panel" role="status" style={{ margin: 0 }}>No tasks are planned in this range. Preview and publish the shop schedule to plan work.</p>}
      {days.map((day) => (
        <section key={day.date} className="ap-panel ap-stack" aria-labelledby={`cal-${day.date}`}>
          <h2 id={`cal-${day.date}`} className="ap-h2">{dayHeading(day.date)}</h2>
          {day.slots.length === 0
            ? <p className="ap-foot" style={{ margin: 0 }}>Nothing planned.</p>
            : <ul className="ap-agenda">
                {day.slots.map((slot) => {
                  const flags = flagLabels(slot.flags);
                  return (
                    <li key={slot.taskId}>
                      <div className="ap-agenda-time">{formatSlotTimes(slot.startUtc, slot.endUtc, report.timeZoneId)}</div>
                      <div>
                        <Link href={`/tasks/${slot.taskId}`}><strong>{slot.title}</strong></Link>
                        <div className="ap-small ap-dim">{slot.orderNumber} · {slot.stageName} · {slot.workerName ?? 'Unassigned'} · {taskStatusText(slot.status)}</div>
                        {flags.length > 0 && <ul className="ap-flags" aria-label="Warnings">{flags.map((label) => <li key={label} className="ap-badge ap-badge-off">{label}</li>)}</ul>}
                      </div>
                    </li>
                  );
                })}
              </ul>}
        </section>
      ))}
    </div>
  );
}
