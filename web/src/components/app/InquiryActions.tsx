'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { formatDateTime } from '@/lib/dates';
import { APPOINTMENT_TYPES, DEFAULT_DURATION, MAX_DURATION, MIN_DURATION, zonedLocalCandidates, zonedUtcOffsetLabel, type AppointmentType } from '@/lib/fittings-view-model';
import {
  MAX_APPOINTMENT_NOTES, MAX_NOTE, buildConvertPayload, buildSchedulePayload, canConvert, canReview, canSchedule,
  type ConvertField, type Inquiry, type ScheduleField, type ScheduledInquiry,
} from '@/lib/inquiries-view-model';
import { ApiError, messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { Field, SelectField, TextAreaField } from './Field';

type Option = { id: string; label: string };
type StaffOption = Option & { isOwner: boolean; locationIds: string[] };
type Mode = 'schedule' | 'convert' | 'review' | null;

/** Everything the page could load for the forms; null means the signed-in user cannot see that list. */
export interface InquiryFormData { locations: Option[]; staff: StaffOption[]; canAssignAllLocations: boolean; currentMembershipId: string | null }

export function InquiryActions({ inquiry, timeZone, canManage, canBook, form }: {
  inquiry: Inquiry; timeZone: string; canManage: boolean; canBook: boolean; form: InquiryFormData | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locations = form?.locations ?? [];
  const defaultLocationId = locations.length === 1 ? locations[0]!.id : '';
  const uid = (name: string) => `inq-${inquiry.id}-${name}`;

  // ---- schedule ----
  const allowedForLocation = (member: StaffOption, selectedLocationId: string) => !!form && (form.canAssignAllLocations || member.isOwner
    || (selectedLocationId ? member.locationIds.includes(selectedLocationId) : false));
  const staffFor = (selectedLocationId: string) => (form?.staff ?? []).filter((member) => allowedForLocation(member, selectedLocationId));
  const initialStaff = staffFor(defaultLocationId);
  const [type, setType] = useState<AppointmentType>('Fitting');
  const [locationId, setLocationId] = useState(defaultLocationId);
  const [assignedMembershipId, setAssignedMembershipId] = useState(
    (initialStaff.find((member) => member.id === form?.currentMembershipId) ?? initialStaff[0])?.id ?? '');
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [occurrence, setOccurrence] = useState('');
  const [duration, setDuration] = useState(String(DEFAULT_DURATION));
  const [notes, setNotes] = useState('');
  const [scheduleErrors, setScheduleErrors] = useState<Partial<Record<ScheduleField, string>>>({});

  function changeLocation(next: string) {
    setLocationId(next);
    const available = staffFor(next);
    setAssignedMembershipId((current) => (available.some((member) => member.id === current) ? current : available[0]?.id ?? ''));
  }

  async function submitSchedule(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const result = buildSchedulePayload({ type, locationId, assignedMembershipId, scheduledLocal, occurrence, duration, notes }, timeZone);
    if (!result.ok) { setScheduleErrors(result.errors); return; }
    setScheduleErrors({});
    setBusy(true);
    try {
      const done = await api<ScheduledInquiry>(`/api/inquiries/${inquiry.id}/schedule`, { method: 'POST', json: result.payload });
      setMode(null);
      toast.success(`${done.appointment.type} scheduled for ${formatDateTime(done.appointment.startUtc, timeZone)}.`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'appointment_conflict' && err.body && typeof err.body === 'object') {
        const conflicts = (err.body as { conflicts?: Array<{ type: string; startUtc: string; conflictOn: string[] }> }).conflicts ?? [];
        setError(conflicts.map((c) => `${c.type} at ${formatDateTime(c.startUtc, timeZone)} (${c.conflictOn.join(' and ')} conflict)`).join('; ') || err.message);
      } else {
        toast.error(messageFor(err));
        if (err instanceof ApiError && err.code === 'inquiry_already_scheduled') router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- convert to order ----
  const [orderLocationId, setOrderLocationId] = useState(defaultLocationId);
  const [promisedDate, setPromisedDate] = useState('');
  const [garmentName, setGarmentName] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [convertErrors, setConvertErrors] = useState<Partial<Record<ConvertField, string>>>({});

  async function submitConvert(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const result = buildConvertPayload({ locationId: orderLocationId, promisedDate, garmentName, unitPrice });
    if (!result.ok) { setConvertErrors(result.errors); return; }
    setConvertErrors({});
    setBusy(true);
    try {
      await api<Inquiry>(`/api/inquiries/${inquiry.id}/convert`, { method: 'POST', json: result.payload });
      setMode(null);
      toast.success('Order created from this request.');
      router.refresh();
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  // ---- status and note ----
  const [status, setStatus] = useState<string>(inquiry.status);
  const [note, setNote] = useState(inquiry.internalNote ?? '');
  const [noteError, setNoteError] = useState<string | null>(null);

  async function submitReview(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (note.length > MAX_NOTE) { setNoteError(`The note can be at most ${MAX_NOTE} characters.`); return; }
    setNoteError(null);
    setBusy(true);
    try {
      await api<Inquiry>(`/api/inquiries/${inquiry.id}`, { method: 'PUT', json: { status, internalNote: note.trim() || null } });
      setMode(null);
      toast.success('Request updated.');
      router.refresh();
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  const showSchedule = canBook && canSchedule(inquiry);
  const showConvert = canManage && canConvert(inquiry);
  const showReview = canManage && canReview(inquiry);
  const toggle = (next: Exclude<Mode, null>) => { setError(null); setMode((current) => (current === next ? null : next)); };
  const formMissing = !form || locations.length === 0;

  if (!showSchedule && !showConvert && !showReview) return null;

  return (
    <div className="ap-stack">
      <div className="ap-actions">
        {showSchedule && <button type="button" className="ap-btn ap-btn-sm" aria-expanded={mode === 'schedule'} onClick={() => toggle('schedule')}>Schedule appointment</button>}
        {showConvert && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" aria-expanded={mode === 'convert'} onClick={() => toggle('convert')}>Convert to order</button>}
        {showReview && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" aria-expanded={mode === 'review'} onClick={() => toggle('review')}>Update status or note</button>}
      </div>
      {error && <p role="alert" className="ap-alert">{error}</p>}

      {mode === 'schedule' && (formMissing ? (
        <p className="ap-hint">Scheduling also needs permission to view staff and locations, and an active location you are assigned to. Ask the business owner to change your role.</p>
      ) : (
        <form className="ap-grid2" onSubmit={submitSchedule} noValidate aria-label="Schedule appointment">
          <p className="ap-hint" style={{ gridColumn: '1 / -1', margin: 0 }}>The customer is matched by email or phone, or added as a new customer.</p>
          <SelectField id={uid('type')} label="Type" value={type} onChange={(value) => setType(value as AppointmentType)} error={scheduleErrors.type}
            options={APPOINTMENT_TYPES.map((value) => ({ value, label: value }))} />
          <SelectField id={uid('location')} label="Location" value={locationId} onChange={changeLocation} error={scheduleErrors.locationId}
            options={[{ value: '', label: 'Choose a location' }, ...locations.map((l) => ({ value: l.id, label: l.label }))]} />
          <SelectField id={uid('staff')} label="Assigned staff" value={assignedMembershipId} onChange={setAssignedMembershipId} error={scheduleErrors.assignedMembershipId}
            options={[{ value: '', label: 'Choose staff' }, ...staffFor(locationId).map((member) => ({ value: member.id, label: member.label }))]} />
          <Field id={uid('when')} label="Date and time" type="datetime-local" value={scheduledLocal} onChange={(value) => { setScheduledLocal(value); setOccurrence(''); }}
            error={scheduleErrors.scheduledLocal} hint={`Time zone: ${timeZone}`} />
          {zonedLocalCandidates(scheduledLocal, timeZone).length > 1 && <SelectField id={uid('occurrence')} label="This local time occurs twice" value={occurrence} onChange={setOccurrence} error={scheduleErrors.occurrence}
            options={[{ value: '', label: 'Choose which time' }, ...zonedLocalCandidates(scheduledLocal, timeZone).map((instant) => ({ value: instant.toISOString(), label: `${formatDateTime(instant.toISOString(), timeZone)} (${zonedUtcOffsetLabel(instant, timeZone)})` }))]} />}
          <Field id={uid('duration')} label="Duration (minutes)" type="number" inputMode="numeric" min={MIN_DURATION} max={MAX_DURATION} step={5} value={duration} onChange={setDuration} error={scheduleErrors.duration} />
          <TextAreaField id={uid('notes')} label="Appointment notes (optional)" rows={3} maxLength={MAX_APPOINTMENT_NOTES} value={notes} onChange={setNotes} error={scheduleErrors.notes}
            hint="Left empty, the customer's message is copied here." />
          <div><button type="submit" className="ap-btn" disabled={busy || staffFor(locationId).length === 0}>{busy ? 'Scheduling…' : 'Schedule appointment'}</button></div>
        </form>
      ))}

      {mode === 'convert' && (formMissing ? (
        <p className="ap-hint">Converting also needs permission to view locations. Ask the business owner to change your role.</p>
      ) : (
        <form className="ap-grid2" onSubmit={submitConvert} noValidate aria-label="Convert to order">
          <SelectField id={uid('order-location')} label="Location" value={orderLocationId} onChange={setOrderLocationId} error={convertErrors.locationId}
            options={[{ value: '', label: 'Choose a location' }, ...locations.map((l) => ({ value: l.id, label: l.label }))]} />
          <Field id={uid('promised')} label="Promised date" type="date" value={promisedDate} onChange={setPromisedDate} error={convertErrors.promisedDate} />
          <Field id={uid('garment')} label="Garment name (optional)" value={garmentName} onChange={setGarmentName} maxLength={120} error={convertErrors.garmentName} />
          <Field id={uid('price')} label="Price" inputMode="decimal" value={unitPrice} onChange={setUnitPrice} error={convertErrors.unitPrice} />
          <div><button type="submit" className="ap-btn" disabled={busy}>{busy ? 'Creating…' : 'Create order'}</button></div>
        </form>
      ))}

      {mode === 'review' && (
        <form className="ap-grid2" onSubmit={submitReview} noValidate aria-label="Update request">
          <SelectField id={uid('status')} label="Status" value={status} onChange={setStatus}
            options={['New', 'Reviewed', 'Rejected'].map((value) => ({ value, label: value }))} />
          <TextAreaField id={uid('note')} label="Internal note" rows={3} maxLength={MAX_NOTE} value={note} onChange={setNote} error={noteError ?? undefined} />
          <div><button type="submit" className="ap-btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
        </form>
      )}
    </div>
  );
}
