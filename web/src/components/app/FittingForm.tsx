'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { formatDateTime } from '@/lib/dates';
import { APPOINTMENT_TYPES, DEFAULT_DURATION, MAX_DURATION, MAX_NOTES, MIN_DURATION, buildAppointmentPayload, zonedLocalCandidates, zonedUtcOffsetLabel, type AppointmentDraftField, type AppointmentType } from '@/lib/fittings-view-model';
import { ApiError, messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { Field, SelectField, TextAreaField } from './Field';

type Option = { id: string; label: string };
type StaffOption = Option & { isOwner: boolean; locationIds: string[] };

export function FittingForm({ customers, locations, staff, timeZone, currentMembershipId, canAssignAllLocations }: {
  customers: Option[]; locations: Option[]; staff: StaffOption[]; timeZone: string; currentMembershipId: string | null; canAssignAllLocations: boolean;
}) {
  const router = useRouter();
  const allowedForLocation = (member: StaffOption, selectedLocationId: string) => canAssignAllLocations || member.isOwner
    || (selectedLocationId ? member.locationIds.includes(selectedLocationId) : false);
  const defaultLocationId = locations.length === 1 ? locations[0]!.id : '';
  const initialStaff = staff.find((member) => member.id === currentMembershipId && allowedForLocation(member, defaultLocationId))
    ?? staff.find((member) => allowedForLocation(member, defaultLocationId));
  const [type, setType] = useState<AppointmentType>('Fitting');
  const [customerId, setCustomerId] = useState('');
  const [locationId, setLocationId] = useState(defaultLocationId);
  const [assignedMembershipId, setAssignedMembershipId] = useState(initialStaff?.id ?? '');
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [occurrence, setOccurrence] = useState('');
  const [duration, setDuration] = useState(String(DEFAULT_DURATION));
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<AppointmentDraftField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const assignableStaff = staff.filter((member) => allowedForLocation(member, locationId));

  function changeLocation(nextLocationId: string) {
    setLocationId(nextLocationId);
    const available = staff.filter((member) => allowedForLocation(member, nextLocationId));
    setAssignedMembershipId((current) => available.some((member) => member.id === current) ? current : available[0]?.id ?? '');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const result = buildAppointmentPayload({ type, customerId, locationId, assignedMembershipId, scheduledLocal, occurrence, duration, notes }, timeZone);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    setBusy(true);
    try {
      await api('/api/appointments', { method: 'POST', json: result.payload });
      setCustomerId(''); setScheduledLocal(''); setOccurrence(''); setDuration(String(DEFAULT_DURATION)); setNotes('');
      toast.success(`${type} scheduled.`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'appointment_conflict' && err.body && typeof err.body === 'object') {
        const conflicts = (err.body as { conflicts?: Array<{ type: string; startUtc: string; conflictOn: string[] }> }).conflicts ?? [];
        setError(conflicts.map((conflict) => `${conflict.type} at ${formatDateTime(conflict.startUtc, timeZone)} (${conflict.conflictOn.join(' and ')} conflict)`).join('; ') || err.message);
      } else toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ap-panel ap-stack" aria-labelledby="fit-new-h">
      <h2 id="fit-new-h" className="ap-h2">Schedule an appointment</h2>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <form className="ap-grid2" onSubmit={submit} noValidate>
        <SelectField id="appt-type" label="Type" value={type} onChange={(value) => setType(value as AppointmentType)} error={errors.type}
          options={APPOINTMENT_TYPES.map((value) => ({ value, label: value }))} />
        <SelectField id="fit-customer" label="Customer" value={customerId} onChange={setCustomerId} error={errors.customerId}
          options={[{ value: '', label: 'Choose a customer' }, ...customers.map((c) => ({ value: c.id, label: c.label }))]} />
        <SelectField id="fit-location" label="Location" value={locationId} onChange={changeLocation} error={errors.locationId}
          options={[{ value: '', label: 'Choose a location' }, ...locations.map((l) => ({ value: l.id, label: l.label }))]} />
        <SelectField id="appt-staff" label="Assigned staff" value={assignedMembershipId} onChange={setAssignedMembershipId} error={errors.assignedMembershipId}
          options={[{ value: '', label: 'Choose staff' }, ...assignableStaff.map((member) => ({ value: member.id, label: member.label }))]} />
        <Field id="fit-when" label="Date and time" type="datetime-local" value={scheduledLocal} onChange={(value) => { setScheduledLocal(value); setOccurrence(''); }} error={errors.scheduledLocal} hint={`Time zone: ${timeZone}`} />
        {zonedLocalCandidates(scheduledLocal, timeZone).length > 1 && <SelectField id="appt-occurrence" label="This local time occurs twice" value={occurrence} onChange={setOccurrence} error={errors.occurrence}
          options={[{ value: '', label: 'Choose which time' }, ...zonedLocalCandidates(scheduledLocal, timeZone).map((instant) => ({ value: instant.toISOString(), label: `${formatDateTime(instant.toISOString(), timeZone)} (${zonedUtcOffsetLabel(instant, timeZone)})` }))]} />}
        <Field id="fit-duration" label="Duration (minutes)" type="number" inputMode="numeric" min={MIN_DURATION} max={MAX_DURATION} step={5} value={duration} onChange={setDuration} error={errors.duration} />
        <TextAreaField id="fit-notes" label="Notes" rows={3} maxLength={MAX_NOTES} value={notes} onChange={setNotes} error={errors.notes} />
        <div><button type="submit" className="ap-btn" disabled={busy || assignableStaff.length === 0}>{busy ? 'Scheduling…' : 'Schedule appointment'}</button></div>
      </form>
    </section>
  );
}
