import { buildAppointmentPayload, type AppointmentDraftField, type AppointmentType } from './fittings-view-model';

/** Mirrors backend-node/src/auth/inquiryService.js (dto) and the schedule route in storefrontRoutes.js. */
export const INQUIRY_STATUSES = ['New', 'Reviewed', 'Converted', 'Rejected'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
export const INQUIRY_KINDS = ['Inquiry', 'Quotation', 'OrderRequest', 'Appointment', 'Contact'] as const;
export type InquiryKind = (typeof INQUIRY_KINDS)[number];

export interface Inquiry {
  id: string;
  kind: InquiryKind;
  status: InquiryStatus;
  name: string;
  email: string | null;
  phone: string | null;
  message: string;
  designId: string | null;
  designName: string | null;
  garmentType: string | null;
  budget: string | null;
  preferredDate: string | null;
  eventDate: string | null;
  convertedOrderId: string | null;
  appointmentId: string | null;
  internalNote: string | null;
  createdAtUtc: string;
  handledAtUtc: string | null;
}

export interface ScheduledInquiry { inquiry: Inquiry; appointment: { id: string; startUtc: string; endUtc: string; type: AppointmentType } }

export const INQUIRIES_PAGE_SIZE = 25;
export const MAX_NOTE = 1000;
export const MAX_APPOINTMENT_NOTES = 2000;

const KIND_LABELS: Record<string, string> = {
  Appointment: 'Booking request', OrderRequest: 'Custom order request', Quotation: 'Quotation request', Inquiry: 'Inquiry', Contact: 'Contact message',
};
export const inquiryKindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

export function inquiryStatusTone(status: string): 'on' | 'off' | 'neutral' {
  if (status === 'Converted') return 'on';
  if (status === 'Rejected') return 'off';
  return 'neutral';
}

/** The API sends a date column as a full timestamp; only the day matters. */
export const dayOf = (value: string | null | undefined): string | null => {
  const day = value ? String(value).slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

/** What happened to a handled request, in words. */
export function inquiryOutcome(i: Pick<Inquiry, 'status' | 'convertedOrderId' | 'appointmentId'>): string | null {
  if (i.status === 'Converted' && i.appointmentId) return 'Appointment scheduled';
  if (i.status === 'Converted' && i.convertedOrderId) return 'Became an order';
  if (i.status === 'Converted') return 'Converted';
  return null;
}

const open = (i: Pick<Inquiry, 'status'>) => i.status === 'New' || i.status === 'Reviewed';
/** Only a booking request that is still open and has no appointment can be scheduled. */
export const canSchedule = (i: Pick<Inquiry, 'kind' | 'status' | 'appointmentId'>) => i.kind === 'Appointment' && open(i) && !i.appointmentId;
export const canConvert = (i: Pick<Inquiry, 'status' | 'appointmentId'>) => open(i) && !i.appointmentId;
/** A converted request is closed for good; the API refuses to change it. */
export const canReview = (i: Pick<Inquiry, 'status'>) => i.status !== 'Converted';

// ---- list query ----
export interface InquiriesQuery { page: number; status?: InquiryStatus; kind?: InquiryKind }
type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseInquiriesQuery(raw: Raw): InquiriesQuery {
  const n = Number.parseInt(first(raw.page) ?? '1', 10);
  const page = Number.isFinite(n) && n >= 1 && n <= 100000 ? n : 1;
  const status = first(raw.status) ?? '';
  const kind = first(raw.kind) ?? '';
  return {
    page,
    ...((INQUIRY_STATUSES as readonly string[]).includes(status) ? { status: status as InquiryStatus } : {}),
    ...((INQUIRY_KINDS as readonly string[]).includes(kind) ? { kind: kind as InquiryKind } : {}),
  };
}

export function inquiriesApiQuery(q: InquiriesQuery): string {
  const p = new URLSearchParams({ page: String(q.page), pageSize: String(INQUIRIES_PAGE_SIZE) });
  if (q.status) p.set('status', q.status);
  if (q.kind) p.set('kind', q.kind);
  return p.toString();
}

export function inquiriesHref(q: InquiriesQuery, overrides: Partial<InquiriesQuery> = {}): string {
  const m = { ...q, ...overrides };
  const p = new URLSearchParams();
  if (m.page > 1) p.set('page', String(m.page));
  if (m.status) p.set('status', m.status);
  if (m.kind) p.set('kind', m.kind);
  const s = p.toString();
  return s ? `/inquiries?${s}` : '/inquiries';
}

// ---- schedule form ----
export interface ScheduleDraft {
  type: AppointmentType; locationId: string; assignedMembershipId: string; scheduledLocal: string; occurrence: string; duration: string; notes: string;
}
export type ScheduleField = Exclude<AppointmentDraftField, 'customerId'>;
export interface SchedulePayload { type: AppointmentType; locationId: string; assignedMembershipId: string; startAt: string; endAt: string; notes: string | null }
export type ScheduleResult = { ok: true; payload: SchedulePayload } | { ok: false; errors: Partial<Record<ScheduleField, string>> };

/** The customer is found or created by the server, so the form never asks for one. The time rules are the appointment form's. */
export function buildSchedulePayload(draft: ScheduleDraft, timeZone: string, now: Date = new Date()): ScheduleResult {
  const result = buildAppointmentPayload({ ...draft, customerId: 'from-request' }, timeZone, now);
  if (!result.ok) {
    const { customerId: _ignored, ...errors } = result.errors;
    return { ok: false, errors };
  }
  const { customerId: _customer, ...payload } = result.payload;
  return { ok: true, payload };
}

// ---- convert-to-order form ----
export interface ConvertDraft { locationId: string; promisedDate: string; garmentName: string; unitPrice: string }
export type ConvertField = keyof ConvertDraft;
export interface ConvertPayload { locationId: string; promisedDate: string; garmentName: string | null; unitPrice: number }
export type ConvertResult = { ok: true; payload: ConvertPayload } | { ok: false; errors: Partial<Record<ConvertField, string>> };

const validDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
};

export function buildConvertPayload(draft: ConvertDraft): ConvertResult {
  const errors: Partial<Record<ConvertField, string>> = {};
  if (!draft.locationId) errors.locationId = 'Choose a location.';
  if (!draft.promisedDate) errors.promisedDate = 'Enter the promised date.';
  else if (!validDay(draft.promisedDate)) errors.promisedDate = 'Enter a valid date.';
  const garmentName = draft.garmentName.trim();
  if (garmentName.length > 120) errors.garmentName = 'The garment name can be at most 120 characters.';
  const priceText = draft.unitPrice.trim();
  const unitPrice = Number(priceText);
  if (!priceText || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000_000 || !/^\d+(\.\d{1,2})?$/.test(priceText)) {
    errors.unitPrice = 'Enter the price as a number with at most two decimals.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, payload: { locationId: draft.locationId, promisedDate: draft.promisedDate, garmentName: garmentName || null, unitPrice } };
}
