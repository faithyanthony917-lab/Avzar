import { describe, expect, it } from 'vitest';
import {
  buildAppointmentInterval, buildAppointmentPayload, buildFittingPayload, fittingStatusLabel, fittingStatusTone, fittingsApiQuery, fittingsHref, needsOutcome, nextStatuses,
  parseFittingsQuery, startOfTodayUtc, validDuration, zonedLocalCandidates, zonedLocalToUtc, type AppointmentDraft, type FittingDraft,
} from '../fittings-view-model';
import { visibleNav } from '../nav';

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('zonedLocalToUtc', () => {
  it('reads wall-clock time in the business zone', () => {
    expect(iso(zonedLocalToUtc('2026-11-02T09:00', 'Africa/Lagos'))).toBe('2026-11-02T08:00:00.000Z');
  });
  it('follows daylight saving: EDT in July, EST after the November change', () => {
    expect(iso(zonedLocalToUtc('2026-07-01T09:00', 'America/New_York'))).toBe('2026-07-01T13:00:00.000Z');
    expect(iso(zonedLocalToUtc('2026-11-02T09:00', 'America/New_York'))).toBe('2026-11-02T14:00:00.000Z');
  });
  it('rejects nonexistent spring-forward wall times and enumerates both fall-back instants', () => {
    expect(zonedLocalCandidates('2026-03-08T02:30', 'America/New_York')).toEqual([]);
    expect(zonedLocalCandidates('2026-11-01T01:30', 'America/New_York').map((instant) => instant.toISOString())).toEqual([
      '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z',
    ]);
    expect(zonedLocalToUtc('2026-11-01T01:30', 'America/New_York')).toBeNull();
  });
  it('treats an unknown zone as UTC', () => {
    expect(iso(zonedLocalToUtc('2026-11-02T09:00', 'Not/AZone'))).toBe('2026-11-02T09:00:00.000Z');
  });
  it.each([['2026-02-31T10:00'], ['2026-11-02 09:00'], ['2026-11-02T25:00'], ['bad'], ['']])('refuses %j', (v) => {
    expect(zonedLocalToUtc(v, 'Africa/Lagos')).toBeNull();
  });
});

describe('startOfTodayUtc', () => {
  it('is local midnight of the business day, not UTC midnight', () => {
    expect(iso(startOfTodayUtc('Africa/Lagos', new Date('2026-11-02T10:00:00Z')))).toBe('2026-11-01T23:00:00.000Z');
    expect(iso(startOfTodayUtc('Africa/Lagos', new Date('2026-11-02T23:30:00Z')))).toBe('2026-11-02T23:00:00.000Z');
  });
});

describe('fittings list query', () => {
  it('defaults to upcoming, page 1', () => expect(parseFittingsQuery({})).toEqual({ view: 'upcoming', page: 1 }));
  it('keeps a known view and page, using the first of repeated params', () => {
    expect(parseFittingsQuery({ view: ['all', 'upcoming'], page: ['3', '9'] })).toEqual({ view: 'all', page: 3 });
  });
  it('keeps valid appointment type and staff filters', () => {
    expect(parseFittingsQuery({ type: 'Delivery', assignedMembershipId: 'staff-1' })).toEqual({
      view: 'upcoming', page: 1, type: 'Delivery', assignedMembershipId: 'staff-1',
    });
    expect(new URLSearchParams(fittingsApiQuery({ view: 'all', page: 1, type: 'Consultation', assignedMembershipId: 'staff-1' }, 'UTC')).get('type')).toBe('Consultation');
  });
  it.each([['0'], ['-2'], ['abc'], ['100001'], ['']])('falls back to page 1 for %j', (page) => {
    expect(parseFittingsQuery({ page }).page).toBe(1);
  });
  it('ignores an unknown view', () => expect(parseFittingsQuery({ view: 'past' }).view).toBe('upcoming'));

  it('asks the API for fittings from the start of today when upcoming', () => {
    const p = new URLSearchParams(fittingsApiQuery({ view: 'upcoming', page: 2 }, 'Africa/Lagos', new Date('2026-11-02T10:00:00Z')));
    expect(p.get('page')).toBe('2');
    expect(p.get('pageSize')).toBe('25');
    expect(p.get('from')).toBe('2026-11-01T23:00:00.000Z');
  });
  it('sends no date filter for the full list', () => {
    expect(new URLSearchParams(fittingsApiQuery({ view: 'all', page: 1 }, 'Africa/Lagos')).has('from')).toBe(false);
  });
  it('builds links that omit defaults', () => {
    expect(fittingsHref({ view: 'upcoming', page: 1 })).toBe('/fittings');
    expect(fittingsHref({ view: 'upcoming', page: 1 }, { view: 'all' })).toBe('/fittings?view=all');
    expect(fittingsHref({ view: 'all', page: 1 }, { page: 2 })).toBe('/fittings?view=all&page=2');
  });
});

describe('fitting statuses', () => {
  it('only offers outcomes for a scheduled fitting', () => {
    expect(nextStatuses('Scheduled')).toEqual(['Completed', 'Cancelled', 'NoShow']);
    for (const s of ['Completed', 'Cancelled', 'NoShow', 'Unknown']) expect(nextStatuses(s)).toEqual([]);
  });
  it('labels and tones statuses, with a neutral fallback', () => {
    expect(fittingStatusLabel('NoShow')).toBe('No-show');
    expect(fittingStatusLabel('Scheduled')).toBe('Scheduled');
    expect(fittingStatusTone('Completed')).toBe('on');
    expect(fittingStatusTone('Cancelled')).toBe('off');
    expect(fittingStatusTone('NoShow')).toBe('off');
    expect(fittingStatusTone('Scheduled')).toBe('neutral');
    expect(fittingStatusTone('Something')).toBe('neutral');
  });
  it('flags a scheduled fitting that ended without an outcome', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    const f = { status: 'Scheduled' as const, scheduledAtUtc: '2026-11-02T08:00:00Z', durationMinutes: 30 };
    expect(needsOutcome(f, now)).toBe(true);
    expect(needsOutcome({ ...f, scheduledAtUtc: '2026-11-02T09:45:00Z' }, now)).toBe(false); // still in progress
    expect(needsOutcome({ ...f, scheduledAtUtc: '2026-11-03T08:00:00Z' }, now)).toBe(false);
    expect(needsOutcome({ ...f, status: 'Completed' as never }, now)).toBe(false);
    expect(needsOutcome({ ...f, scheduledAtUtc: 'nonsense' }, now)).toBe(false);
  });
});

describe('validDuration', () => {
  it.each([[5, true], [30, true], [480, true], [4, false], [481, false], [30.5, false], [Number.NaN, false], [0, false]])('%s -> %s', (n, ok) => {
    expect(validDuration(n)).toBe(ok);
  });
});

describe('buildFittingPayload', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const draft: FittingDraft = { customerId: 'c1', locationId: 'l1', scheduledLocal: '2026-11-02T09:00', duration: '30', notes: '' };

  it('builds the API body with the time converted from the business zone to UTC', () => {
    expect(buildFittingPayload(draft, 'Africa/Lagos', now)).toEqual({
      ok: true,
      payload: { customerId: 'c1', locationId: 'l1', scheduledAt: '2026-11-02T08:00:00.000Z', durationMinutes: 30, notes: null },
    });
  });
  it('trims notes and keeps non-blank ones', () => {
    const r = buildFittingPayload({ ...draft, notes: '  hem pins  ' }, 'Africa/Lagos', now);
    expect(r.ok && r.payload.notes).toBe('hem pins');
  });
  it('reports every missing field at once', () => {
    const r = buildFittingPayload({ customerId: '', locationId: '', scheduledLocal: '', duration: '', notes: '' }, 'Africa/Lagos', now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['customerId', 'duration', 'locationId', 'scheduledLocal']);
  });
  it('refuses a time that is not in the future, judged in the business zone', () => {
    // 00:30 in Lagos on 2 Nov is 23:30Z on 1 Nov: already past when "now" is 23:45Z.
    const r = buildFittingPayload({ ...draft, scheduledLocal: '2026-11-02T00:30' }, 'Africa/Lagos', new Date('2026-11-01T23:45:00Z'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.scheduledLocal).toMatch(/future/);
  });
  it('refuses an impossible date and out-of-range durations', () => {
    const bad = buildFittingPayload({ ...draft, scheduledLocal: '2026-02-31T10:00', duration: '4' }, 'Africa/Lagos', now);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['duration', 'scheduledLocal']);
    for (const duration of ['481', '30.5', 'abc']) expect(buildFittingPayload({ ...draft, duration }, 'Africa/Lagos', now).ok).toBe(false);
    for (const duration of ['5', '480']) expect(buildFittingPayload({ ...draft, duration }, 'Africa/Lagos', now).ok).toBe(true);
  });
  it('refuses notes over the API limit', () => {
    expect(buildFittingPayload({ ...draft, notes: 'x'.repeat(2001) }, 'Africa/Lagos', now).ok).toBe(false);
    expect(buildFittingPayload({ ...draft, notes: 'x'.repeat(2000) }, 'Africa/Lagos', now).ok).toBe(true);
  });
});

describe('buildAppointmentPayload', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  const draft: AppointmentDraft = {
    type: 'Fitting', customerId: 'customer-1', locationId: 'location-1', assignedMembershipId: 'staff-1',
    scheduledLocal: '2026-11-01T01:30', duration: '30', notes: '', occurrence: '',
  };

  it('requires the user to choose an occurrence in a fall-back overlap and sends UTC-offset-aware values', () => {
    const missingChoice = buildAppointmentPayload(draft, 'America/New_York', now);
    expect(missingChoice.ok).toBe(false);
    if (!missingChoice.ok) expect(missingChoice.errors.occurrence).toMatch(/Choose/);

    const choice = zonedLocalCandidates(draft.scheduledLocal, 'America/New_York')[1]!.toISOString();
    const selected = buildAppointmentPayload({ ...draft, occurrence: choice }, 'America/New_York', now);
    expect(selected).toEqual({ ok: true, payload: {
      type: 'Fitting', customerId: 'customer-1', locationId: 'location-1', assignedMembershipId: 'staff-1',
      startAt: '2026-11-01T06:30:00.000Z', endAt: '2026-11-01T07:00:00.000Z', notes: null,
    } });
  });

  it('rejects spring-forward gaps instead of silently shifting the appointment', () => {
    const result = buildAppointmentPayload({ ...draft, scheduledLocal: '2026-03-08T02:30' }, 'America/New_York', now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.scheduledLocal).toMatch(/does not exist/);
  });
});

describe('buildAppointmentInterval', () => {
  it('requires a fall-back occurrence and returns an explicit UTC interval', () => {
    const missing = buildAppointmentInterval('2026-11-01T01:30', '30', '', 'America/New_York', new Date('2026-10-31T00:00:00Z'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.occurrence).toBeTruthy();
    const selected = buildAppointmentInterval('2026-11-01T01:30', '30', '2026-11-01T06:30:00.000Z', 'America/New_York', new Date('2026-10-31T00:00:00Z'));
    expect(selected).toEqual({ ok: true, startAt: '2026-11-01T06:30:00.000Z', endAt: '2026-11-01T07:00:00.000Z' });
  });

  it('rejects spring-forward gaps and invalid durations', () => {
    expect(buildAppointmentInterval('2026-03-08T02:30', '30', '', 'America/New_York', new Date('2026-03-01T00:00:00Z')).ok).toBe(false);
    expect(buildAppointmentInterval('2026-03-09T02:30', '481', '', 'America/New_York', new Date('2026-03-01T00:00:00Z')).ok).toBe(false);
  });
});

describe('fittings navigation', () => {
  const hrefs = (u: { isOwner: boolean; permissions: string[] }) => visibleNav(u).map((i) => i.href);
  it('shows the page to anyone who can view orders, the permission the list endpoint needs', () => {
    expect(hrefs({ isOwner: false, permissions: ['orders.view'] })).toContain('/fittings');
  });
  it('does not show it for managing fittings alone, or with no permissions', () => {
    expect(hrefs({ isOwner: false, permissions: ['fittings.manage'] })).not.toContain('/fittings');
    expect(hrefs({ isOwner: false, permissions: [] })).not.toContain('/fittings');
  });
  it('always shows it to an owner', () => expect(hrefs({ isOwner: true, permissions: [] })).toContain('/fittings'));
});
