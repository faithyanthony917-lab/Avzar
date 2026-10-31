import { todayIn } from './orders';

/** Mirrors backend-node/src/auth/appointmentService.js and its fitting compatibility DTO. */
export const FITTING_STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'NoShow'] as const;
export type FittingStatus = (typeof FITTING_STATUSES)[number];
export const APPOINTMENT_TYPES = ['Fitting', 'Consultation', 'Collection', 'Delivery'] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];

export interface Appointment {
  id: string;
  type: AppointmentType;
  customerId: string;
  orderId: string | null;
  locationId: string;
  assignedMembershipId: string | null;
  startUtc: string;
  endUtc: string;
  timeZoneId: string;
  status: FittingStatus;
  notes: string | null;
  cancellationReason: string | null;
}

export interface Fitting {
  id: string;
  customerId: string;
  orderId: string | null;
  locationId: string;
  scheduledAtUtc: string;
  durationMinutes: number;
  status: FittingStatus;
  notes: string | null;
}

export const FITTINGS_PAGE_SIZE = 25;
export const MIN_DURATION = 5;
export const MAX_DURATION = 480;
export const DEFAULT_DURATION = 30;
export const MAX_NOTES = 2000;

const STATUS_LABELS: Record<string, string> = { NoShow: 'No-show' };
export const fittingStatusLabel = (s: string) => STATUS_LABELS[s] ?? s;

/** Which badge colour a status gets. Unknown statuses stay neutral rather than throwing. */
export function fittingStatusTone(s: string): 'on' | 'off' | 'neutral' {
  if (s === 'Completed') return 'on';
  if (s === 'Cancelled' || s === 'NoShow') return 'off';
  return 'neutral';
}

/** Only a scheduled fitting can be closed out here. The API refuses to reopen a completed one. */
export function nextStatuses(status: string): FittingStatus[] {
  return status === 'Scheduled' ? ['Completed', 'Cancelled', 'NoShow'] : [];
}

/** A scheduled fitting whose time has passed still needs someone to record what happened. */
export function needsOutcome(f: Pick<Fitting, 'status' | 'scheduledAtUtc' | 'durationMinutes'>, now: Date = new Date()): boolean {
  if (f.status !== 'Scheduled') return false;
  const start = Date.parse(f.scheduledAtUtc);
  if (Number.isNaN(start)) return false;
  return start + Math.max(0, f.durationMinutes) * 60_000 < now.getTime();
}

// ---- time zones ----

/** The zone's offset from UTC (ms) at an instant. Falls back to UTC for an unknown zone id, like lib/dates.ts. */
function zoneOffsetMs(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wallAsUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
    return wallAsUtc - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    return 0;
  }
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function wallTime(local: string): number | null {
  const m = LOCAL.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null;
  return wall;
}

function wallTimeAt(instant: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(instant);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(instant);
  }
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

export function instantToZonedLocal(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return '';
  try { return wallTimeAt(date, timeZone); } catch { return wallTimeAt(date, 'UTC'); }
}

export function zonedUtcOffsetLabel(instant: Date, timeZone: string): string {
  const format = (zone: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
  try { return format(timeZone); } catch { return format('UTC'); }
}

/** Returns every real instant matching a datetime-local wall time in the requested business time zone. */
export function zonedLocalCandidates(local: string, timeZone: string): Date[] {
  const wall = wallTime(local);
  if (wall === null) return [];
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) offsets.add(zoneOffsetMs(timeZone, new Date(wall + hours * 60 * 60_000)));
  return [...offsets]
    .map((offset) => new Date(wall - offset))
    .filter((instant) => wallTimeAt(instant, timeZone) === local)
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Reads a wall time only when it maps to exactly one instant; gaps and overlaps need caller feedback. */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const candidates = zonedLocalCandidates(local, timeZone);
  return candidates.length === 1 ? candidates[0]! : null;
}

/** The instant today began in the business's zone. */
export function startOfTodayUtc(timeZone: string, now: Date = new Date()): Date {
  return zonedLocalCandidates(`${todayIn(timeZone, now)}T00:00`, timeZone)[0] ?? now;
}

// ---- list query ----

export const FITTING_VIEWS = ['upcoming', 'all'] as const;
export type FittingView = (typeof FITTING_VIEWS)[number];
export interface FittingsQuery { view: FittingView; page: number; type?: AppointmentType; assignedMembershipId?: string }

type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the URL's query string defensively: anything unrecognised falls back to the default. */
export function parseFittingsQuery(raw: Raw): FittingsQuery {
  const viewRaw = first(raw.view) ?? '';
  const view = (FITTING_VIEWS as readonly string[]).includes(viewRaw) ? (viewRaw as FittingView) : 'upcoming';
  const n = Number.parseInt(first(raw.page) ?? '1', 10);
  const page = Number.isFinite(n) && n >= 1 && n <= 100000 ? n : 1;
  const typeRaw = first(raw.type) ?? '';
  const type = (APPOINTMENT_TYPES as readonly string[]).includes(typeRaw) ? typeRaw as AppointmentType : undefined;
  const assignedMembershipId = first(raw.assignedMembershipId);
  return { view, page, ...(type ? { type } : {}), ...(assignedMembershipId ? { assignedMembershipId } : {}) };
}

/** The API lists fittings oldest first, so "upcoming" starts at the beginning of today in the business's zone. */
export function fittingsApiQuery(q: FittingsQuery, timeZone: string, now: Date = new Date()): string {
  const p = new URLSearchParams();
  p.set('page', String(q.page));
  p.set('pageSize', String(FITTINGS_PAGE_SIZE));
  if (q.type) p.set('type', q.type);
  if (q.assignedMembershipId) p.set('assignedMembershipId', q.assignedMembershipId);
  if (q.view === 'upcoming') p.set('from', startOfTodayUtc(timeZone, now).toISOString());
  return p.toString();
}

export function fittingsHref(q: FittingsQuery, overrides: Partial<FittingsQuery> = {}): string {
  const m = { ...q, ...overrides };
  const p = new URLSearchParams();
  if (m.view !== 'upcoming') p.set('view', m.view);
  if (m.page > 1) p.set('page', String(m.page));
  if (m.type) p.set('type', m.type);
  if (m.assignedMembershipId) p.set('assignedMembershipId', m.assignedMembershipId);
  const s = p.toString();
  return s ? `/fittings?${s}` : '/fittings';
}

// ---- schedule form ----

export interface FittingDraft { customerId: string; locationId: string; scheduledLocal: string; duration: string; notes: string }
export type DraftField = 'customerId' | 'locationId' | 'scheduledLocal' | 'duration' | 'notes';
export interface FittingPayload { customerId: string; locationId: string; scheduledAt: string; durationMinutes: number; notes: string | null }
export type DraftResult = { ok: true; payload: FittingPayload } | { ok: false; errors: Partial<Record<DraftField, string>> };

export interface AppointmentDraft extends FittingDraft {
  type: AppointmentType;
  assignedMembershipId: string;
  occurrence: string;
}
export type AppointmentDraftField = DraftField | 'type' | 'assignedMembershipId' | 'occurrence';
export interface AppointmentPayload {
  type: AppointmentType; customerId: string; locationId: string; assignedMembershipId: string;
  startAt: string; endAt: string; notes: string | null;
}
export type AppointmentDraftResult = { ok: true; payload: AppointmentPayload } | { ok: false; errors: Partial<Record<AppointmentDraftField, string>> };

export const validDuration = (n: number): boolean => Number.isInteger(n) && n >= MIN_DURATION && n <= MAX_DURATION;

/** Checks the form the way the API will and builds the request body. The time is read in the business's zone. */
export function buildFittingPayload(draft: FittingDraft, timeZone: string, now: Date = new Date()): DraftResult {
  const errors: Partial<Record<DraftField, string>> = {};
  if (!draft.customerId) errors.customerId = 'Choose a customer.';
  if (!draft.locationId) errors.locationId = 'Choose a location.';

  const at = draft.scheduledLocal ? zonedLocalToUtc(draft.scheduledLocal, timeZone) : null;
  if (!draft.scheduledLocal) errors.scheduledLocal = 'Enter the date and time.';
  else if (!at) errors.scheduledLocal = 'Enter a valid date and time.';
  else if (at.getTime() <= now.getTime()) errors.scheduledLocal = 'A fitting must be scheduled in the future.';

  const durationMinutes = Number(draft.duration);
  if (!draft.duration.trim() || !validDuration(durationMinutes)) errors.duration = `Enter a whole number of minutes from ${MIN_DURATION} to ${MAX_DURATION}.`;

  const notes = draft.notes.trim();
  if (notes.length > MAX_NOTES) errors.notes = `Notes can be at most ${MAX_NOTES} characters.`;

  if (Object.keys(errors).length > 0 || !at) return { ok: false, errors };
  return {
    ok: true,
    payload: { customerId: draft.customerId, locationId: draft.locationId, scheduledAt: at.toISOString(), durationMinutes, notes: notes || null },
  };
}

export function buildAppointmentPayload(draft: AppointmentDraft, timeZone: string, now: Date = new Date()): AppointmentDraftResult {
  const errors: Partial<Record<AppointmentDraftField, string>> = {};
  if (!(APPOINTMENT_TYPES as readonly string[]).includes(draft.type)) errors.type = 'Choose an appointment type.';
  if (!draft.customerId) errors.customerId = 'Choose a customer.';
  if (!draft.locationId) errors.locationId = 'Choose a location.';
  if (!draft.assignedMembershipId) errors.assignedMembershipId = 'Choose an assigned staff member.';

  const candidates = draft.scheduledLocal ? zonedLocalCandidates(draft.scheduledLocal, timeZone) : [];
  if (!draft.scheduledLocal) errors.scheduledLocal = 'Enter the date and time.';
  else if (candidates.length === 0) errors.scheduledLocal = 'That local time does not exist in this time zone because of a clock change.';
  const selected = candidates.length === 1 ? candidates[0] : candidates.find((candidate) => candidate.toISOString() === draft.occurrence);
  if (candidates.length > 1 && !selected) errors.occurrence = 'Choose which occurrence of this local time you mean.';
  if (selected && selected <= now) errors.scheduledLocal = 'An appointment must start in the future.';

  const durationMinutes = Number(draft.duration);
  if (!draft.duration.trim() || !validDuration(durationMinutes)) errors.duration = `Enter a whole number of minutes from ${MIN_DURATION} to ${MAX_DURATION}.`;
  const notes = draft.notes.trim();
  if (notes.length > MAX_NOTES) errors.notes = `Notes can be at most ${MAX_NOTES} characters.`;
  if (Object.keys(errors).length || !selected) return { ok: false, errors };
  const end = new Date(selected.getTime() + durationMinutes * 60_000);
  return {
    ok: true,
    payload: {
      type: draft.type, customerId: draft.customerId, locationId: draft.locationId,
      assignedMembershipId: draft.assignedMembershipId, startAt: selected.toISOString(), endAt: end.toISOString(),
      notes: notes || null,
    },
  };
}

export type AppointmentIntervalResult =
  | { ok: true; startAt: string; endAt: string }
  | { ok: false; errors: Partial<Record<'scheduledLocal' | 'duration' | 'occurrence', string>> };

export function buildAppointmentInterval(scheduledLocal: string, duration: string, occurrence: string, timeZone: string, now: Date = new Date()): AppointmentIntervalResult {
  const errors: Partial<Record<'scheduledLocal' | 'duration' | 'occurrence', string>> = {};
  const candidates = scheduledLocal ? zonedLocalCandidates(scheduledLocal, timeZone) : [];
  if (!scheduledLocal) errors.scheduledLocal = 'Enter the date and time.';
  else if (candidates.length === 0) errors.scheduledLocal = 'That local time does not exist in this time zone because of a clock change.';
  const start = candidates.length === 1 ? candidates[0] : candidates.find((candidate) => candidate.toISOString() === occurrence);
  if (candidates.length > 1 && !start) errors.occurrence = 'Choose which occurrence of this local time you mean.';
  if (start && start <= now) errors.scheduledLocal = 'An appointment must start in the future.';
  const durationMinutes = Number(duration);
  if (!duration.trim() || !validDuration(durationMinutes)) errors.duration = `Enter a whole number of minutes from ${MIN_DURATION} to ${MAX_DURATION}.`;
  if (Object.keys(errors).length || !start) return { ok: false, errors };
  return { ok: true, startAt: start.toISOString(), endAt: new Date(start.getTime() + durationMinutes * 60_000).toISOString() };
}
