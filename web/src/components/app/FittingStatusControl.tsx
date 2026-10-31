'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';
import { formatDateTime } from '@/lib/dates';
import { buildAppointmentInterval, instantToZonedLocal, MAX_DURATION, MIN_DURATION, nextStatuses, zonedLocalCandidates, zonedUtcOffsetLabel, type Appointment, type FittingStatus } from '@/lib/fittings-view-model';
import { ApiError, messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { Field, TextAreaField } from './Field';
import { SelectField } from './Field';

function actionError(error: unknown, timeZone: string): string {
  if (error instanceof ApiError && error.code === 'appointment_conflict' && error.body && typeof error.body === 'object') {
    const conflicts = (error.body as { conflicts?: Array<{ type: string; startUtc: string; conflictOn: string[] }> }).conflicts ?? [];
    if (conflicts.length) return conflicts.map((conflict) =>
      `${conflict.type} at ${formatDateTime(conflict.startUtc, timeZone)} (${conflict.conflictOn.join(' and ')} conflict)`).join('; ');
  }
  return messageFor(error);
}

export function AppointmentActions({ appointment, timeZone, who }: { appointment: Appointment; timeZone: string; who: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showReschedule, setShowReschedule] = useState(false);
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [occurrence, setOccurrence] = useState('');
  const [duration, setDuration] = useState('30');
  const [notes, setNotes] = useState<Partial<Record<'scheduledLocal' | 'duration' | 'occurrence', string>>>({});

  // A clash lists the times that overlap, so it stays beside the open form; every other failure is a pop-up.
  function fail(err: unknown) {
    if (err instanceof ApiError && err.code === 'appointment_conflict') setError(actionError(err, timeZone));
    else toast.error(actionError(err, timeZone));
  }

  async function status(status: FittingStatus) {
    if (busy) return;
    if (!window.confirm(`Mark the appointment for ${who} as ${status.toLowerCase()}?`)) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/appointments/${encodeURIComponent(appointment.id)}/status`, { method: 'POST', json: { status } });
      toast.success(`Appointment marked ${status.toLowerCase()}.`);
      router.refresh();
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (busy) return;
    if (cancelReason.trim().length < 3) { setError('Enter a cancellation reason of at least 3 characters.'); return; }
    if (!window.confirm(`Cancel the appointment for ${who}?`)) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/appointments/${encodeURIComponent(appointment.id)}/cancel`, { method: 'POST', json: { reason: cancelReason.trim() } });
      toast.success('Appointment cancelled.'); setShowCancel(false); setCancelReason(''); router.refresh();
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  }

  async function reschedule() {
    if (busy) return;
    const result = buildAppointmentInterval(scheduledLocal, duration, occurrence, timeZone);
    if (!result.ok) { setNotes(result.errors); return; }
    setBusy(true); setError(null); setNotes({});
    try {
      await api(`/api/appointments/${encodeURIComponent(appointment.id)}/reschedule`, { method: 'POST', json: { startAt: result.startAt, endAt: result.endAt } });
      toast.success('Appointment rescheduled.'); setShowReschedule(false); router.refresh();
    } catch (err) { fail(err); }
    finally { setBusy(false); }
  }

  function beginReschedule() {
    const durationMinutes = Math.round((Date.parse(appointment.endUtc) - Date.parse(appointment.startUtc)) / 60_000);
    setScheduledLocal(instantToZonedLocal(appointment.startUtc, timeZone));
    setDuration(String(durationMinutes)); setOccurrence(''); setNotes({}); setShowReschedule(true); setShowCancel(false); setError(null);
  }

  const actions = nextStatuses(appointment.status);
  const overlapCandidates = zonedLocalCandidates(scheduledLocal, timeZone);
  const hasEnded = Date.parse(appointment.endUtc) <= Date.now();
  return (
    <div className="ap-stack" style={{ gap: '.4rem', minWidth: '14rem' }}>
      <div className="ap-actions">
        {actions.includes('Completed') && hasEnded && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={() => void status('Completed')}>Complete</button>}
        {actions.includes('NoShow') && hasEnded && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={() => void status('NoShow')}>No-show</button>}
        {appointment.status !== 'Completed' && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={beginReschedule}>Reschedule</button>}
        {appointment.status === 'Scheduled' && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={() => { setShowCancel((value) => !value); setShowReschedule(false); }}>Cancel</button>}
      </div>
      {showCancel && <div className="ap-stack">
        <TextAreaField id={`appointment-cancel-${appointment.id}`} label="Cancellation reason" rows={2} maxLength={500} value={cancelReason} onChange={setCancelReason} />
        <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" disabled={busy} onClick={() => void cancel()}>{busy ? 'Cancelling…' : 'Confirm cancellation'}</button>
      </div>}
      {showReschedule && <div className="ap-stack">
        <Field id={`appointment-time-${appointment.id}`} label="New date and time" type="datetime-local" value={scheduledLocal} onChange={(value) => { setScheduledLocal(value); setOccurrence(''); }} error={notes.scheduledLocal} hint={`Time zone: ${timeZone}`} />
        <Field id={`appointment-duration-${appointment.id}`} label="Duration (minutes)" type="number" min={MIN_DURATION} max={MAX_DURATION} step={5} value={duration} onChange={setDuration} error={notes.duration} />
        {overlapCandidates.length > 1 && <SelectField id={`appointment-occurrence-${appointment.id}`} label="This local time occurs twice" value={occurrence} onChange={setOccurrence} error={notes.occurrence}
          options={[{ value: '', label: 'Choose which time' }, ...overlapCandidates.map((instant) => ({ value: instant.toISOString(), label: `${formatDateTime(instant.toISOString(), timeZone)} (${zonedUtcOffsetLabel(instant, timeZone)})` }))]} />}
        <div className="ap-actions"><button type="button" className="ap-btn ap-btn-sm" disabled={busy} onClick={() => void reschedule()}>{busy ? 'Rescheduling…' : 'Save new time'}</button><button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={() => setShowReschedule(false)}>Close</button></div>
      </div>}
      {error && <p role="alert" className="ap-alert">{error}</p>}
    </div>
  );
}