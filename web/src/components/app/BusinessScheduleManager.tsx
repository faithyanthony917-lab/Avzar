'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { isValidBusinessWeek, normalizeTimeInput } from '@/lib/business-schedule';

type DayHours = { dayOfWeek: number; isOpen: boolean; opensAt: string | null; closesAt: string | null };
type Holiday = { id: string; date: string; name: string };
type BusinessSchedule = { timeZoneId: string; days: DayHours[]; holidays: Holiday[] };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const timeInput = normalizeTimeInput;

export function BusinessScheduleManager({ initialSchedule }: { initialSchedule: BusinessSchedule }) {
  const [schedule, setSchedule] = useState<BusinessSchedule>({ ...initialSchedule, days: [...initialSchedule.days].sort((a, b) => a.dayOfWeek - b.dayOfWeek) });
  const [holidayDate, setHolidayDate] = useState('');
  const [holidayName, setHolidayName] = useState('');
  const [busy, setBusy] = useState(false);

  function updateDay(dayOfWeek: number, patch: Partial<DayHours>) {
    setSchedule((old) => ({ ...old, days: old.days.map((d) => d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d) }));
  }
  async function saveHours() {
    setBusy(true);
    try {
      const days = schedule.days.map((d) => ({ ...d, opensAt: d.isOpen ? d.opensAt : null, closesAt: d.isOpen ? d.closesAt : null }));
      const saved = await api<BusinessSchedule>('/api/business/schedule/hours', { method: 'PUT', json: { days } });
      setSchedule((old) => ({ ...old, days: [...saved.days].sort((a, b) => a.dayOfWeek - b.dayOfWeek) }));
      toast.success('Weekly opening hours saved.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }
  async function addHoliday(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true);
    try {
      const holiday = await api<Holiday>('/api/business/schedule/holidays', { method: 'POST', json: { date: holidayDate, name: holidayName.trim() } });
      setSchedule((old) => ({ ...old, holidays: [...old.holidays.filter((h) => h.id !== holiday.id), holiday].sort((a, b) => a.date.localeCompare(b.date)) }));
      setHolidayDate(''); setHolidayName(''); toast.success('Holiday added. The business is treated as closed on that date.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }
  async function removeHoliday(holiday: Holiday) {
    if (!window.confirm(`Remove ${holiday.name} (${holiday.date}) from the holiday calendar?`)) return;
    setBusy(true);
    try { await api(`/api/business/schedule/holidays/${holiday.id}`, { method: 'DELETE' }); setSchedule((old) => ({ ...old, holidays: old.holidays.filter((h) => h.id !== holiday.id) })); toast.success('Holiday removed.'); }
    catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  return <div className="ap-stack">
    <p className="ap-foot" style={{ margin: 0 }}>Set your weekly opening hours and closed dates. Times use the business time zone: <strong>{schedule.timeZoneId}</strong>.</p>
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Weekly opening hours</h2><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Day</th><th>Open?</th><th>Opens</th><th>Closes</th></tr></thead><tbody>{schedule.days.map((day) => <tr key={day.dayOfWeek}><th scope="row">{DAYS[day.dayOfWeek] ?? `Day ${day.dayOfWeek}`}</th><td><label className="ap-check"><input type="checkbox" checked={day.isOpen} disabled={busy} onChange={(e) => updateDay(day.dayOfWeek, { isOpen: e.target.checked, opensAt: e.target.checked ? (day.opensAt ?? '09:00') : null, closesAt: e.target.checked ? (day.closesAt ?? '17:00') : null })} /><span>{day.isOpen ? 'Open' : 'Closed'}</span></label></td><td><input aria-label={`${DAYS[day.dayOfWeek]} opening time`} type="time" className="ap-input" value={timeInput(day.opensAt)} disabled={busy || !day.isOpen} onChange={(e) => updateDay(day.dayOfWeek, { opensAt: e.target.value || null })} /></td><td><input aria-label={`${DAYS[day.dayOfWeek]} closing time`} type="time" className="ap-input" value={timeInput(day.closesAt)} disabled={busy || !day.isOpen} onChange={(e) => updateDay(day.dayOfWeek, { closesAt: e.target.value || null })} /></td></tr>)}</tbody></table></div><p className="ap-foot">An open day must have both times, and closing must be later than opening. Closed days cannot have hours.</p><div><button className="ap-btn" disabled={busy || !isValidBusinessWeek(schedule.days)} onClick={() => void saveHours()}>Save opening hours</button></div></section>
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Holidays and closure dates</h2><p className="ap-foot" style={{ margin: 0 }}>A holiday overrides the weekly schedule and marks the business closed for that date.</p><form className="ap-grid2" onSubmit={(e) => void addHoliday(e)}><div className="ap-field"><label htmlFor="holiday-date">Date</label><input id="holiday-date" type="date" className="ap-input" value={holidayDate} required disabled={busy} onChange={(e) => setHolidayDate(e.target.value)} /></div><div className="ap-field"><label htmlFor="holiday-name">Name</label><input id="holiday-name" className="ap-input" value={holidayName} required maxLength={80} disabled={busy} placeholder="e.g. Annual leave" onChange={(e) => setHolidayName(e.target.value)} /></div><div><button className="ap-btn" disabled={busy || !holidayDate || !holidayName.trim()}>Add closure date</button></div></form><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Date</th><th>Closure</th><th>Action</th></tr></thead><tbody>{schedule.holidays.map((h) => <tr key={h.id}><td>{h.date}</td><td>{h.name}</td><td><button className="ap-btn ap-btn-danger ap-btn-sm" disabled={busy} onClick={() => void removeHoliday(h)}>Remove</button></td></tr>)}</tbody></table>{schedule.holidays.length === 0 && <p className="ap-foot">No closure dates added.</p>}</div></section>
  </div>;
}
