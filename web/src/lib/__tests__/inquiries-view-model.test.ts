import { describe, expect, it } from 'vitest';
import {
  buildConvertPayload, buildSchedulePayload, canConvert, canReview, canSchedule, dayOf, inquiriesApiQuery, inquiriesHref, inquiryKindLabel,
  inquiryOutcome, inquiryStatusTone, parseInquiriesQuery, type ScheduleDraft,
} from '../inquiries-view-model';

const NOW = new Date('2026-10-26T09:00:00Z');
const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  type: 'Fitting', locationId: 'loc', assignedMembershipId: 'mem', scheduledLocal: '2026-11-03T10:00', occurrence: '', duration: '30', notes: '', ...over,
});

describe('what can be done with a request', () => {
  it('schedules only an open booking request that has no appointment', () => {
    expect(canSchedule({ kind: 'Appointment', status: 'New', appointmentId: null })).toBe(true);
    expect(canSchedule({ kind: 'Appointment', status: 'Reviewed', appointmentId: null })).toBe(true);
    expect(canSchedule({ kind: 'Inquiry', status: 'New', appointmentId: null })).toBe(false);
    expect(canSchedule({ kind: 'Appointment', status: 'Converted', appointmentId: 'a' })).toBe(false);
    expect(canSchedule({ kind: 'Appointment', status: 'Rejected', appointmentId: null })).toBe(false);
  });
  it('converts only an open request, and closes a converted one for good', () => {
    expect(canConvert({ status: 'New', appointmentId: null })).toBe(true);
    expect(canConvert({ status: 'Rejected', appointmentId: null })).toBe(false);
    expect(canConvert({ status: 'Reviewed', appointmentId: 'a' })).toBe(false);
    expect(canReview({ status: 'Rejected' })).toBe(true);
    expect(canReview({ status: 'Converted' })).toBe(false);
  });
  it('says what became of a handled request', () => {
    expect(inquiryOutcome({ status: 'Converted', convertedOrderId: null, appointmentId: 'a' })).toBe('Appointment scheduled');
    expect(inquiryOutcome({ status: 'Converted', convertedOrderId: 'o', appointmentId: null })).toBe('Became an order');
    expect(inquiryOutcome({ status: 'New', convertedOrderId: null, appointmentId: null })).toBeNull();
  });
  it('labels kinds and tones statuses, and leaves unknown values alone', () => {
    expect(inquiryKindLabel('Appointment')).toBe('Booking request');
    expect(inquiryKindLabel('Mystery')).toBe('Mystery');
    expect(inquiryStatusTone('Converted')).toBe('on');
    expect(inquiryStatusTone('Rejected')).toBe('off');
    expect(inquiryStatusTone('New')).toBe('neutral');
  });
  it('reads the day out of a date column the API sends as a timestamp', () => {
    expect(dayOf('2026-10-29T00:00:00.000Z')).toBe('2026-10-29');
    expect(dayOf('2026-10-29')).toBe('2026-10-29');
    expect(dayOf(null)).toBeNull();
    expect(dayOf('soon')).toBeNull();
  });
});

describe('list query', () => {
  it('falls back to defaults for anything unrecognised', () => {
    expect(parseInquiriesQuery({})).toEqual({ page: 1 });
    expect(parseInquiriesQuery({ page: '0', status: 'Nope', kind: 'Nope' })).toEqual({ page: 1 });
    expect(parseInquiriesQuery({ page: '3', status: 'New', kind: 'Appointment' })).toEqual({ page: 3, status: 'New', kind: 'Appointment' });
  });
  it('builds the API query and the page links', () => {
    expect(inquiriesApiQuery({ page: 2, status: 'New', kind: 'Appointment' })).toBe('page=2&pageSize=25&status=New&kind=Appointment');
    expect(inquiriesHref({ page: 1 })).toBe('/inquiries');
    expect(inquiriesHref({ page: 1, status: 'New' }, { page: 2 })).toBe('/inquiries?page=2&status=New');
  });
});

describe('schedule payload', () => {
  it('builds the request without a customer, reading the time in the business zone', () => {
    const result = buildSchedulePayload(draft({ notes: '  Bring the jacket  ' }), 'Africa/Lagos', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      type: 'Fitting', locationId: 'loc', assignedMembershipId: 'mem', startAt: '2026-11-03T09:00:00.000Z', endAt: '2026-11-03T09:30:00.000Z', notes: 'Bring the jacket',
    });
    expect('customerId' in result.payload).toBe(false);
  });
  it('sends no note when none is typed', () => {
    const result = buildSchedulePayload(draft(), 'UTC', NOW);
    expect(result.ok && result.payload.notes).toBeNull();
  });
  it('lists every missing field and never asks for a customer', () => {
    const result = buildSchedulePayload(draft({ locationId: '', assignedMembershipId: '', scheduledLocal: '', duration: '' }), 'UTC', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['assignedMembershipId', 'duration', 'locationId', 'scheduledLocal']);
  });
  it('refuses a time in the past and a duration out of range', () => {
    const past = buildSchedulePayload(draft({ scheduledLocal: '2026-10-01T10:00' }), 'UTC', NOW);
    expect(!past.ok && past.errors.scheduledLocal).toMatch(/future/);
    const long = buildSchedulePayload(draft({ duration: '600' }), 'UTC', NOW);
    expect(!long.ok && long.errors.duration).toBeTruthy();
  });
});

describe('convert payload', () => {
  const ok = { locationId: 'loc', promisedDate: '2026-11-20', garmentName: '  Agbada ', unitPrice: '125.50' };
  it('builds the body the convert route expects', () => {
    expect(buildConvertPayload(ok)).toEqual({ ok: true, payload: { locationId: 'loc', promisedDate: '2026-11-20', garmentName: 'Agbada', unitPrice: 125.5 } });
    const bare = buildConvertPayload({ ...ok, garmentName: ' ' });
    expect(bare.ok && bare.payload.garmentName).toBeNull();
  });
  it('checks location, date and price', () => {
    const empty = buildConvertPayload({ locationId: '', promisedDate: '', garmentName: '', unitPrice: '' });
    expect(!empty.ok && Object.keys(empty.errors).sort()).toEqual(['locationId', 'promisedDate', 'unitPrice']);
    for (const price of ['1.001', '-5', 'abc', '1e3']) expect(buildConvertPayload({ ...ok, unitPrice: price }).ok).toBe(false);
    expect(buildConvertPayload({ ...ok, promisedDate: '2026-02-30' }).ok).toBe(false);
    expect(buildConvertPayload({ ...ok, unitPrice: '0' }).ok).toBe(true);
  });
});
