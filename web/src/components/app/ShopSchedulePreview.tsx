'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { Pager, usePaged } from '@/components/app/Pager';

type Slot = { taskId: string; startUtc: string; endUtc: string; version: number };
type Unscheduled = { taskId: string; reason: string };
type Preview = {
  startUtc: string;
  horizonDays: number;
  timeZoneId: string;
  scheduled: Slot[];
  unscheduled: Unscheduled[];
  taskVersions: Record<string, number>;
  isPreviewOnly: boolean;
};
type Applied = { versionId: string; versionNumber: number; updatedTasks: number; appliedAtUtc: string; notificationsQueued: boolean };

/** A failed preview or publish is a pop-up; a plan-related failure gets the hint about the scheduling plan. */
const failureText = (message: string) => `${message}${/entitlement|subscription|plan/i.test(message) ? ' This feature may require the shop scheduling plan.' : ''}`;
type VersionSlot = {
  taskId: string;
  title: string;
  orderNumber: string;
  locationId: string;
  assignedMembershipId: string | null;
  startUtc: string;
  endUtc: string;
};
type ScheduleVersion = {
  id: string;
  versionNumber: number;
  startUtc: string;
  horizonDays: number;
  timeZoneId: string;
  publishedAtUtc: string;
  taskCount: number;
  slots: VersionSlot[];
};

function displayTime(value: string, timeZoneId: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timeZoneId,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function VersionSlots({ version }: { version: ScheduleVersion }) {
  const paged = usePaged(version.slots);
  return <>
    <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Order</th><th>Task</th><th>Starts ({version.timeZoneId})</th><th>Ends ({version.timeZoneId})</th></tr></thead><tbody>
      {paged.slice.map((slot) => <tr key={slot.taskId}><td>{slot.orderNumber}</td><td>{slot.title}</td><td>{displayTime(slot.startUtc, version.timeZoneId)}</td><td>{displayTime(slot.endUtc, version.timeZoneId)}</td></tr>)}
    </tbody></table></div>
    <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label={`Version ${version.versionNumber} pages`} />
  </>;
}

export function ShopSchedulePreview({ timeZoneId }: { timeZoneId: string }) {
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [horizonDays, setHorizonDays] = useState(30);
  const [publishReason, setPublishReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [versions, setVersions] = useState<ScheduleVersion[]>([]);
  const [versionsBusy, setVersionsBusy] = useState(true);
  const [versionsError, setVersionsError] = useState('');
  const [versionsReload, setVersionsReload] = useState(0);
  const pagedScheduled = usePaged(preview?.scheduled ?? []);
  const pagedUnscheduled = usePaged(preview?.unscheduled ?? []);

  useEffect(() => {
    let active = true;
    api<ScheduleVersion[]>('/api/tasks/schedule/versions')
      .then((result) => { if (active) setVersions(result); })
      .catch((err) => { if (active) setVersionsError(messageFor(err)); })
      .finally(() => { if (active) setVersionsBusy(false); });
    return () => { active = false; };
  }, [versionsReload]);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const result = await api<Preview>('/api/tasks/schedule/preview', {
        method: 'POST',
        json: { startUtc: `${startDate}T00:00:00+00:00`, horizonDays },
      });
      setPreview(result);
    } catch (err) {
      toast.error(failureText(messageFor(err)));
    } finally {
      setBusy(false);
    }
  }

  async function applySchedule() {
    if (!preview || preview.unscheduled.length > 0 || preview.scheduled.length !== Object.keys(preview.taskVersions).length) return;
    if (publishReason.trim().length < 3) { setError('Enter a reason for publishing this schedule (at least 3 characters).'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await api<Applied>('/api/tasks/schedule/apply', {
        method: 'POST',
        json: {
          startUtc: preview.startUtc,
          horizonDays: preview.horizonDays,
          reason: publishReason.trim(),
          expectedTaskVersions: preview.taskVersions,
          expectedSlots: preview.scheduled,
        },
      });
      toast.success(`Published schedule version ${result.versionNumber} for ${result.updatedTasks} tasks. ${result.notificationsQueued ? 'Assigned workers were notified.' : 'No assigned workers needed a schedule notification.'}`);
      setPublishReason('');
      setPreview(null);
      setVersionsError('');
      setVersionsBusy(true);
      setVersionsReload((value) => value + 1);
    } catch (err) {
      toast.error(failureText(messageFor(err)));
    } finally {
      setBusy(false);
    }
  }

  return <div className="ap-stack">
    <section className="ap-panel ap-stack">
      <h2 className="ap-h2">Generate a proposed schedule</h2>
      <p className="ap-foot" style={{ margin: 0 }}>Avzar uses shop hours, closure dates, worker availability, approved leave, daily workload capacity, estimates, dependencies and existing task reservations. Preview does not change task schedules.</p>
      <form className="ap-grid2" onSubmit={(event) => void generate(event)}>
        <div className="ap-field">
          <label htmlFor="schedule-start">Start date (UTC)</label>
          <input id="schedule-start" className="ap-input" type="date" value={startDate} required disabled={busy} onChange={(event) => setStartDate(event.target.value)} />
        </div>
        <div className="ap-field">
          <label htmlFor="schedule-horizon">Planning horizon</label>
          <select id="schedule-horizon" className="ap-input" value={horizonDays} disabled={busy} onChange={(event) => setHorizonDays(Number(event.target.value))}>
            <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={60}>60 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={366}>366 days</option>
          </select>
        </div>
        <div><button className="ap-btn" type="submit" disabled={busy || !startDate}>{busy ? 'Planning…' : 'Generate preview'}</button></div>
      </form>
      <p className="ap-foot" style={{ margin: 0 }}>Business time zone: <strong>{timeZoneId}</strong>. The start date is submitted at 00:00 UTC.</p>
      {error && <p className="ap-alert" role="alert">{error}</p>}
    </section>

    <section className="ap-stack" aria-labelledby="schedule-history-heading">
      <div className="ap-row"><h2 id="schedule-history-heading" className="ap-h2" style={{ margin: 0 }}>Published versions</h2><span className="ap-foot">Latest 25</span></div>
      {versionsBusy ? <p className="ap-foot" role="status">Loading schedule history…</p>
        : versionsError ? <p className="ap-alert" role="alert">{versionsError}</p>
          : versions.length === 0 ? <p className="ap-foot">No schedules have been published yet.</p>
            : <div className="ap-stack">{versions.map((version) => <details key={version.id}>
              <summary className="ap-row" style={{ cursor: 'pointer' }}>
                <strong>Version {version.versionNumber}</strong>
                <span>{displayTime(version.publishedAtUtc, version.timeZoneId)}</span>
                <span>{version.taskCount} tasks · {version.horizonDays} days from {displayTime(version.startUtc, version.timeZoneId)}</span>
              </summary>
              <VersionSlots version={version} />
            </details>)}</div>}
    </section>

    {preview && <>
      <section className="ap-panel ap-stack" aria-live="polite">
        <div className="ap-row"><h2 className="ap-h2" style={{ margin: 0 }}>Proposed schedule</h2><span className="ap-badge">Preview only</span></div>
        <div className="ap-grid2">
          <div><div className="ap-small ap-dim">Scheduled tasks</div><strong>{preview.scheduled.length}</strong></div>
          <div><div className="ap-small ap-dim">Needs attention</div><strong>{preview.unscheduled.length}</strong></div>
        </div>
        {preview.scheduled.length === 0 ? <p style={{ margin: 0 }}>No tasks could be scheduled in this horizon. Review the reasons below or check shop hours, task estimates and assignments.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Task ID</th><th>Starts ({preview.timeZoneId})</th><th>Ends ({preview.timeZoneId})</th></tr></thead><tbody>{pagedScheduled.slice.map((slot) => <tr key={slot.taskId}><td><code>{slot.taskId}</code></td><td>{displayTime(slot.startUtc, preview.timeZoneId)}</td><td>{displayTime(slot.endUtc, preview.timeZoneId)}</td></tr>)}</tbody></table></div>}
        <Pager page={pagedScheduled.page} pages={pagedScheduled.pages} total={pagedScheduled.total} size={pagedScheduled.size} onPage={pagedScheduled.setPage} label="Proposed schedule pages" />
        <div className="ap-row">
          <p className="ap-foot" style={{ margin: 0 }}>{preview.unscheduled.length > 0 ? 'Resolve every unscheduled task before applying this plan.' : 'Applying saves the proposed times, creates task audit events, and queues deduplicated assignment emails plus future 24-hour reminders.'}</p>
          <div className="ap-field"><label htmlFor="schedule-publish-reason">Reason for publishing / overriding schedule</label><input id="schedule-publish-reason" className="ap-input" maxLength={500} value={publishReason} disabled={busy} onChange={(event) => setPublishReason(event.target.value)} placeholder="e.g. Adjusted after staff availability review" required /></div>
          <button className="ap-btn" type="button" disabled={busy || publishReason.trim().length < 3 || preview.unscheduled.length > 0 || preview.scheduled.length === 0 || preview.scheduled.length !== Object.keys(preview.taskVersions).length} onClick={() => void applySchedule()}>{busy ? 'Applying…' : 'Apply schedule'}</button>
        </div>
      </section>
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">Tasks not scheduled</h2>
        {preview.unscheduled.length === 0 ? <p style={{ margin: 0 }}>Every candidate task received a proposed slot.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Task ID</th><th>Reason</th></tr></thead><tbody>{pagedUnscheduled.slice.map((task) => <tr key={task.taskId}><td><code>{task.taskId}</code></td><td>{task.reason}</td></tr>)}</tbody></table></div>}
        <Pager page={pagedUnscheduled.page} pages={pagedUnscheduled.pages} total={pagedUnscheduled.total} size={pagedUnscheduled.size} onPage={pagedUnscheduled.setPage} label="Tasks not scheduled pages" />
      </section>
    </>}
  </div>;
}
