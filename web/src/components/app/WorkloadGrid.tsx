import { dayHeading, formatMinutes, workloadCell, type WorkloadReport } from '@/lib/production-view';

/** Planned time against capacity, one row per worker and one column per business-local day. */
export function WorkloadGrid({ report }: { report: WorkloadReport }) {
  const f = report.forecast;
  return (
    <div className="ap-stack">
      <section className="ap-panel ap-stack" aria-labelledby="wl-forecast">
        <h2 id="wl-forecast" className="ap-h2">Forecast</h2>
        <dl className="ap-dl">
          <dt>Capacity</dt><dd>{formatMinutes(f.totalCapacityMinutes)}</dd>
          <dt>Planned</dt><dd>{formatMinutes(f.totalPlannedMinutes)}</dd>
          <dt>Assigned, not yet planned</dt><dd>{formatMinutes(f.unplannedMinutes)}</dd>
          <dt>Days over capacity</dt><dd>{f.overDays}</dd>
          <dt>Unassigned tasks</dt><dd>{f.unassignedTasks}</dd>
          <dt>Tasks without an estimate</dt><dd>{f.tasksWithoutEstimate}</dd>
        </dl>
        {f.shortfallMinutes > 0
          ? <p role="status" style={{ margin: 0 }}><strong>Short by {formatMinutes(f.shortfallMinutes)}.</strong> Planned and assigned work is more than the capacity in this range.</p>
          : <p className="ap-foot" role="status" style={{ margin: 0 }}>Planned and assigned work fits the capacity in this range.</p>}
        {report.scopedToLocations && <p className="ap-foot" style={{ margin: 0 }}>Showing workers and tasks in your locations only.</p>}
      </section>
      <section className="ap-panel" aria-label="Workload by worker">
        {report.workers.length === 0
          ? <p style={{ margin: 0 }}>No active workers to show. Add workers on the Team page and give them availability.</p>
          : <div className="ap-scroll">
              <table className="ap-table ap-wl">
                <caption className="ap-sr">Planned time against capacity, per worker and day</caption>
                <thead>
                  <tr>
                    <th scope="col">Worker</th>
                    {report.days.map((date) => <th scope="col" key={date}>{dayHeading(date)}</th>)}
                    <th scope="col">Not yet planned</th>
                  </tr>
                </thead>
                <tbody>
                  {report.workers.map((worker) => (
                    <tr key={worker.membershipId}>
                      <th scope="row">{worker.displayName}{worker.overDays > 0 && <div className="ap-small ap-wl-over">{worker.overDays} day{worker.overDays === 1 ? '' : 's'} over</div>}</th>
                      {worker.days.map((day) => {
                        const cell = workloadCell(day);
                        return <td key={day.date} className={`ap-wl-${day.status}`}>{cell.text}{day.status !== 'ok' && day.status !== 'off' && <div className="ap-small">{cell.statusText}</div>}</td>;
                      })}
                      <td>{worker.unplannedTasks > 0 ? `${worker.unplannedTasks} task${worker.unplannedTasks === 1 ? '' : 's'}, ${formatMinutes(worker.unplannedMinutes)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
      </section>
    </div>
  );
}
