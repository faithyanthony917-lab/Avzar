'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { validLeaveInterval } from '@/lib/worker-schedule-view-model';
import { LeaveCollisionBadge } from '@/components/app/LeaveCollisions';
import { Pager, usePaged } from '@/components/app/Pager';
import { WorkerCalendarFeeds } from '@/components/app/WorkerCalendarFeeds';
import { conflictsByLeaveId, type LeaveConflict, type LeaveConflictsReport } from '@/lib/worker-today';

type Worker = { membershipId: string; displayName: string; isActive: boolean; skills: string[]; openTasks: number };
type Day = { dayOfWeek: number; isAvailable: boolean; opensAt: string | null; closesAt: string | null; capacityMinutes: number };
type Availability = { membershipId: string; isConfigured: boolean; days: Day[] };
type Leave = { id: string; membershipId: string; startsAtUtc: string; endsAtUtc: string; reason: string; status: string };
type CalendarItem = { taskId: string; orderId: string; title: string; status: string; startUtc: string; endUtc: string; deadlineUtc: string | null };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const emptyWeek = (): Day[] => DAYS.map((_, dayOfWeek) => ({ dayOfWeek, isAvailable: true, opensAt: '09:00', closesAt: '17:00', capacityMinutes: 480 }));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function WorkerScheduleManager({ initialWorkers, canManage, canRequest, timeZoneId }: { initialWorkers: Worker[]; canManage: boolean; canRequest: boolean; timeZoneId: string }) {
  const workers = initialWorkers.filter((w) => w.isActive);
  const [membershipId, setMembershipId] = useState(workers[0]?.membershipId ?? '');
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [days, setDays] = useState<Day[]>(emptyWeek());
  const [leave, setLeave] = useState<Leave[]>([]);
  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [fromDate, setFromDate] = useState(() => isoDate(new Date()));
  const [toDate, setToDate] = useState(() => isoDate(new Date(Date.now() + 14 * 86400000)));
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [leaveReason, setLeaveReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingRequests, setPendingRequests] = useState<Leave[]>([]);
  const [conflicts, setConflicts] = useState<Record<string, LeaveConflict>>({});
  const [savedSkills, setSavedSkills] = useState<Record<string, string[]>>({});
  const [skillsText, setSkillsText] = useState('');
  const pagedCalendar = usePaged(calendar);
  const pagedPending = usePaged(pendingRequests);
  const pagedLeave = usePaged(leave);

  const refresh = useCallback(async () => {
    if (!membershipId) return;
    setBusy(true); setError('');
    try {
      const [a, l, c] = await Promise.all([
        api<Availability>(`/api/workers/${membershipId}/schedule/availability`),
        api<Leave[]>(`/api/workers/${membershipId}/schedule/leave?fromUtc=${encodeURIComponent(`${fromDate}T00:00:00+00:00`)}&toUtc=${encodeURIComponent(`${toDate}T23:59:59+00:00`)}`),
        api<CalendarItem[]>(`/api/workers/${membershipId}/schedule/calendar?fromUtc=${encodeURIComponent(`${fromDate}T00:00:00+00:00`)}&toUtc=${encodeURIComponent(`${toDate}T23:59:59+00:00`)}`),
      ]);
      setAvailability(a); setDays(a.isConfigured && a.days.length === 7 ? [...a.days].sort((x, y) => x.dayOfWeek - y.dayOfWeek) : emptyWeek());
      setLeave(l); setCalendar(c);
      if (canManage) setPendingRequests(await api<Leave[]>(`/api/workers/${membershipId}/schedule/leave-requests/pending`).catch(() => []));
      // Collision notes are information only: when they cannot be loaded the flags are left out and nothing else is blocked.
      if (canManage) setConflicts(await api<LeaveConflictsReport>('/api/production/leave-conflicts').then(conflictsByLeaveId).catch(() => ({})));
    } catch (e) { setError(messageFor(e)); }
    finally { setBusy(false); }
  }, [membershipId, fromDate, toDate]);

  useEffect(() => { void refresh(); }, [refresh]);

  function updateDay(dayOfWeek: number, patch: Partial<Day>) {
    setDays((old) => old.map((day) => day.dayOfWeek === dayOfWeek ? { ...day, ...patch } : day));
  }
  async function saveAvailability() {
    setBusy(true); setError('');
    try {
      const saved = await api<Availability>(`/api/workers/${membershipId}/schedule/availability`, { method: 'PUT', json: { days } });
      setAvailability(saved); setDays([...saved.days].sort((x, y) => x.dayOfWeek - y.dayOfWeek)); toast.success('Worker availability and daily capacity saved.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }
  async function addLeave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validLeaveInterval(leaveStart, leaveEnd)) { setError('Choose a valid leave end time after the start time.'); return; }
    setBusy(true); setError('');
    try {
      await api<Leave>(`/api/workers/${membershipId}/schedule/leave`, { method: 'POST', json: { startsAtUtc: new Date(leaveStart).toISOString(), endsAtUtc: new Date(leaveEnd).toISOString(), reason: leaveReason.trim() } });
      setLeaveStart(''); setLeaveEnd(''); setLeaveReason(''); toast.success('Approved leave added. The scheduler will avoid this interval.'); await refresh();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }
  async function cancelLeave(item: Leave) {
    if (!window.confirm(`Cancel leave from ${formatDate(item.startsAtUtc)}?`)) return;
    setBusy(true); setError('');
    try { await api(`/api/workers/${membershipId}/schedule/leave/${item.id}`, { method: 'DELETE' }); toast.success('Leave cancelled.'); await refresh(); }
    catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function reviewRequest(item: Leave, approve: boolean) {
    setBusy(true); setError('');
    try {
      await api<Leave>(`/api/workers/${membershipId}/schedule/leave-requests/${item.id}/review`, { method: 'POST', json: { approve } });
      toast.success(approve ? 'Leave request approved.' : 'Leave request rejected.'); await refresh();
    } catch (e) { toast.error(messageFor(e)); } finally { setBusy(false); }
  }
  async function requestMyLeave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validLeaveInterval(leaveStart, leaveEnd)) { setError('Choose a valid leave end time after the start time.'); return; }
    setBusy(true); setError('');
    try {
      await api<Leave>('/api/my/leave-requests', { method: 'POST', json: { startsAtUtc: new Date(leaveStart).toISOString(), endsAtUtc: new Date(leaveEnd).toISOString(), reason: leaveReason.trim() } });
      setLeaveStart(''); setLeaveEnd(''); setLeaveReason(''); toast.success('Leave request submitted for approval.'); await refresh();
    } catch (e) { toast.error(messageFor(e)); } finally { setBusy(false); }
  }

  if (workers.length === 0) return <section className="ap-panel"><p style={{ margin: 0 }}>No active workers are available to schedule yet.</p></section>;
  useEffect(() => {
    const current = savedSkills[membershipId] ?? initialWorkers.find((w) => w.membershipId === membershipId)?.skills ?? [];
    setSkillsText(current.join(', '));
  }, [membershipId, savedSkills, initialWorkers]);

  async function saveSkills() {
    // The server trims, lower-cases and de-duplicates; do the same here so the screen shows what was stored.
    const list = [...new Set(skillsText.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (list.length > 30) { setError('A worker can have at most 30 skills.'); return; }
    if (list.some((x) => x.length > 60)) { setError('Each skill can be at most 60 characters.'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/workers/${membershipId}/skills`, { method: 'PUT', json: { skills: list } });
      setSavedSkills((old) => ({ ...old, [membershipId]: list }));
      toast.success('Worker skills saved. The scheduler uses them to decide who can take each task.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  const selectedWorker = workers.find((w) => w.membershipId === membershipId);
  const currentSkills = savedSkills[membershipId] ?? selectedWorker?.skills ?? [];
  return <div className="ap-stack">
    {error && <p className="ap-alert" role="alert">{error}</p>}
    <section className="ap-panel ap-stack">
      <h2 className="ap-h2">Worker calendar</h2>
      <div className="ap-grid2">
        <div className="ap-field"><label htmlFor="worker-select">Worker</label><select id="worker-select" className="ap-input" value={membershipId} disabled={busy} onChange={(e) => setMembershipId(e.target.value)}>{workers.map((w) => <option key={w.membershipId} value={w.membershipId}>{w.displayName} · {w.openTasks} open task(s)</option>)}</select></div>
        <div className="ap-field"><label htmlFor="worker-from">From (UTC)</label><input id="worker-from" type="date" className="ap-input" value={fromDate} disabled={busy} onChange={(e) => setFromDate(e.target.value)} /></div>
        <div className="ap-field"><label htmlFor="worker-to">To (UTC)</label><input id="worker-to" type="date" className="ap-input" value={toDate} disabled={busy} onChange={(e) => setToDate(e.target.value)} /></div>
        <div className="ap-field"><span className="ap-foot">{currentSkills.length ? `Skills: ${currentSkills.join(', ')}` : 'No skills recorded'}</span><button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => void refresh()}>Refresh calendar</button></div>
      </div>
      {canManage && selectedWorker && <div className="ap-field"><label htmlFor="worker-skills">Skills (comma-separated)</label><div className="ap-actions"><input id="worker-skills" className="ap-input" value={skillsText} maxLength={1800} disabled={busy} onChange={(e) => setSkillsText(e.target.value)} placeholder="tailoring, embroidery, pressing" /><button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => void saveSkills()}>Save skills</button></div></div>}
      <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Task</th><th>Status</th><th>Starts (UTC)</th><th>Ends (UTC)</th><th>Deadline</th></tr></thead><tbody>{pagedCalendar.slice.map((item) => <tr key={item.taskId}><td>{item.title}<div className="ap-small ap-dim">Order {item.orderId}</div></td><td>{item.status}</td><td>{formatDate(item.startUtc)}</td><td>{formatDate(item.endUtc)}</td><td>{item.deadlineUtc ? formatDate(item.deadlineUtc) : '—'}</td></tr>)}</tbody></table>{calendar.length === 0 && <p className="ap-foot">No planned tasks in this date range.</p>}</div>
      <Pager page={pagedCalendar.page} pages={pagedCalendar.pages} total={pagedCalendar.total} size={pagedCalendar.size} onPage={pagedCalendar.setPage} label="Planned tasks pages" />
    </section>
    {canManage && selectedWorker && <WorkerCalendarFeeds membershipId={membershipId} workerName={selectedWorker.displayName} />}
    <section className="ap-panel ap-stack">
      <h2 className="ap-h2">Recurring availability and workload capacity</h2>
      <p className="ap-foot" style={{ margin: 0 }}>Availability hours use the business time zone ({timeZoneId}). {availability?.isConfigured ? 'The saved worker-specific calendar is active.' : 'No worker-specific calendar is saved. The scheduler currently falls back to the shop opening hours; saving below enables worker-specific hours.'} Capacity is the maximum minutes of scheduled production work per local day.</p>
      <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Weekday</th><th>Available</th><th>From</th><th>To</th><th>Daily capacity (minutes)</th></tr></thead><tbody>{days.map((day) => <tr key={day.dayOfWeek}><th scope="row">{DAYS[day.dayOfWeek]}</th><td><input type="checkbox" aria-label={`${DAYS[day.dayOfWeek]} available`} checked={day.isAvailable} disabled={!canManage || busy} onChange={(e) => updateDay(day.dayOfWeek, { isAvailable: e.target.checked, opensAt: e.target.checked ? (day.opensAt ?? '09:00') : null, closesAt: e.target.checked ? (day.closesAt ?? '17:00') : null, capacityMinutes: e.target.checked ? (day.capacityMinutes || 480) : 0 })} /></td><td><input type="time" className="ap-input" value={day.opensAt ?? ''} disabled={!canManage || busy || !day.isAvailable} onChange={(e) => updateDay(day.dayOfWeek, { opensAt: e.target.value || null })} /></td><td><input type="time" className="ap-input" value={day.closesAt ?? ''} disabled={!canManage || busy || !day.isAvailable} onChange={(e) => updateDay(day.dayOfWeek, { closesAt: e.target.value || null })} /></td><td><input type="number" className="ap-input" min={1} max={1440} value={day.capacityMinutes} disabled={!canManage || busy || !day.isAvailable} onChange={(e) => updateDay(day.dayOfWeek, { capacityMinutes: Number(e.target.value) })} /></td></tr>)}</tbody></table></div>
      {canManage && <button type="button" className="ap-btn" disabled={busy} onClick={() => void saveAvailability()}>Save worker availability</button>}
    </section>
    <section className="ap-panel ap-stack">
      <h2 className="ap-h2">Leave and time off</h2>
      {canManage && <div className="ap-stack"><h3 className="ap-h2">Pending leave requests</h3>{pendingRequests.length === 0 ? <p className="ap-foot">No pending requests.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Worker</th><th>Starts (UTC)</th><th>Ends (UTC)</th><th>Reason</th><th>Review</th></tr></thead><tbody>{pagedPending.slice.map((item) => <tr key={item.id}><td>{workers.find((w) => w.membershipId === item.membershipId)?.displayName ?? item.membershipId}</td><td>{formatDate(item.startsAtUtc)}</td><td>{formatDate(item.endsAtUtc)}</td><td>{item.reason}<LeaveCollisionBadge conflict={conflicts[item.id]} timeZone={timeZoneId} /></td><td><button type="button" className="ap-btn ap-btn-sm" disabled={busy} onClick={() => void reviewRequest(item, true)}>Approve</button> <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" disabled={busy} onClick={() => void reviewRequest(item, false)}>Reject</button></td></tr>)}</tbody></table></div>}<Pager page={pagedPending.page} pages={pagedPending.pages} total={pagedPending.total} size={pagedPending.size} onPage={pagedPending.setPage} label="Pending leave requests pages" /></div>}
      {canRequest && <form className="ap-grid2" onSubmit={(e) => void requestMyLeave(e)}><div className="ap-field"><label htmlFor="request-leave-start">Request leave from</label><input id="request-leave-start" className="ap-input" type="datetime-local" required value={leaveStart} disabled={busy} onChange={(e) => setLeaveStart(e.target.value)} /></div><div className="ap-field"><label htmlFor="request-leave-end">Request leave until</label><input id="request-leave-end" className="ap-input" type="datetime-local" required value={leaveEnd} disabled={busy} onChange={(e) => setLeaveEnd(e.target.value)} /></div><div className="ap-field"><label htmlFor="request-leave-reason">Reason</label><input id="request-leave-reason" className="ap-input" maxLength={300} minLength={2} required value={leaveReason} disabled={busy} onChange={(e) => setLeaveReason(e.target.value)} /></div><div><button className="ap-btn" disabled={busy || !leaveStart || !leaveEnd || new Date(leaveEnd) <= new Date(leaveStart)}>Submit leave request</button></div></form>}
      {canManage && <form className="ap-grid2" onSubmit={(e) => void addLeave(e)}><div className="ap-field"><label htmlFor="leave-start">Starts (your local time)</label><input id="leave-start" className="ap-input" type="datetime-local" required value={leaveStart} disabled={busy} onChange={(e) => setLeaveStart(e.target.value)} /></div><div className="ap-field"><label htmlFor="leave-end">Ends (your local time)</label><input id="leave-end" className="ap-input" type="datetime-local" required value={leaveEnd} disabled={busy} onChange={(e) => setLeaveEnd(e.target.value)} /></div><div className="ap-field"><label htmlFor="leave-reason">Reason</label><input id="leave-reason" className="ap-input" maxLength={300} minLength={2} required value={leaveReason} disabled={busy} onChange={(e) => setLeaveReason(e.target.value)} /></div><div><button className="ap-btn" disabled={busy || !leaveStart || !leaveEnd || new Date(leaveEnd) <= new Date(leaveStart)}>Add approved leave</button></div></form>}
      <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Starts (UTC)</th><th>Ends (UTC)</th><th>Reason</th><th>Status</th>{canManage && <th>Action</th>}</tr></thead><tbody>{pagedLeave.slice.map((item) => <tr key={item.id}><td>{formatDate(item.startsAtUtc)}</td><td>{formatDate(item.endsAtUtc)}</td><td>{item.reason}</td><td>{item.status}<LeaveCollisionBadge conflict={conflicts[item.id]} timeZone={timeZoneId} /></td>{canManage && <td>{item.status === 'Approved' && <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" disabled={busy} onClick={() => void cancelLeave(item)}>Cancel</button>}</td>}</tr>)}</tbody></table>{leave.length === 0 && <p className="ap-foot">No leave in this date range.</p>}</div>
      <Pager page={pagedLeave.page} pages={pagedLeave.pages} total={pagedLeave.total} size={pagedLeave.size} onPage={pagedLeave.setPage} label="Leave pages" />
    </section>
  </div>;
}
