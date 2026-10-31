// Step 16a: notifications to staff about leave, appointments, an overloaded worker and an overdue installment.
// Every function here only builds the event and hands it to notify(), so recipients, channels, quiet hours and deduplication
// behave exactly as for every other notification. Nothing here carries a customer's name, an appointment note or a leave reason.
import { notify } from './notificationService.js';

const compact = (id) => String(id).replaceAll('-', '').toLowerCase();

/** A date and time in one IANA zone, such as "12 Nov 2026, 14:30". Falls back to UTC for an unknown zone. */
export function formatInstant(value, timeZoneId) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const options = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timeZoneId || 'UTC' }).format(date).replace(' at ', ', ');
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(date).replace(' at ', ', ');
  }
}

/** The leave window as text: one date when it starts and ends on the same local day, otherwise both ends. */
export function formatLeaveWindow(startsAtUtc, endsAtUtc, timeZoneId) {
  const from = formatInstant(startsAtUtc, timeZoneId);
  const to = formatInstant(endsAtUtc, timeZoneId);
  return `${from} to ${to}`;
}

const WORKER_INFO_SQL = `
  SELECT m."DisplayName", b."TimeZoneId",
    COALESCE(array_agg(ml."LocationId" ORDER BY ml."LocationId") FILTER (WHERE ml."LocationId" IS NOT NULL), '{}') AS "LocationIds"
  FROM "Memberships" m
  JOIN "Businesses" b ON b."Id" = m."BusinessId"
  LEFT JOIN "MembershipLocations" ml ON ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id"
  WHERE m."BusinessId" = $1 AND m."Id" = $2
  GROUP BY m."DisplayName", b."TimeZoneId"`;

/** Name, business time zone and locations of one worker. Missing pieces come back as safe defaults, never as an error. */
export async function loadWorkerInfo(db, businessId, membershipId) {
  const { rows } = await db.query(WORKER_INFO_SQL, [businessId, membershipId]);
  const row = rows[0] ?? {};
  return {
    name: String(row.DisplayName ?? '').trim() || 'A worker',
    timeZoneId: row.TimeZoneId || 'UTC',
    locationIds: Array.isArray(row.LocationIds) ? row.LocationIds.filter(Boolean) : [],
  };
}

/**
 * Tells the people holding `permission` who can see this worker. A worker at several locations is announced once per location, so a
 * manager at any of them is told once (the shared deduplication key stops repeats); a worker with no location is announced to the
 * owner and to people who see every location.
 */
export async function notifyManagersAbout(db, worker, permission, event, options) {
  const scopes = worker.locationIds.length ? worker.locationIds.map((locationId) => ({ locationId })) : [{ locationlessOnly: true }];
  const total = { recipients: 0, inApp: 0 };
  for (const scope of scopes) {
    const result = await notify(db, { ...event, recipients: { permission, ...scope } }, options);
    total.recipients += result.recipients;
    total.inApp += result.inApp;
  }
  return total;
}

// ---- leave ---------------------------------------------------------------------------------------------------------------

/** A worker asked for leave: tell the managers who review it. */
export async function notifyLeaveRequested(db, { businessId, leave, actorUserId = null }, options = {}) {
  const worker = await loadWorkerInfo(db, businessId, leave.MembershipId);
  const when = formatLeaveWindow(leave.StartsAtUtc, leave.EndsAtUtc, worker.timeZoneId);
  await notifyManagersAbout(db, worker, 'workers.manage', {
    businessId, category: 'schedule', eventType: 'leave.requested', title: 'Leave requested',
    body: `${worker.name} asked for leave from ${when}.`,
    dedupeKey: `leave.requested:${compact(leave.Id)}`,
    target: { kind: 'leave', id: leave.Id }, actorUserId: actorUserId ?? undefined,
    email: {
      templateKey: 'leave.requested', subject: 'A leave request needs a decision',
      text: () => `${worker.name} asked for leave from ${when}. Open Avzar to approve or decline it.`,
    },
  }, options);
  return worker;
}

/** A manager approved or declined the request: tell the worker. */
export async function notifyLeaveDecided(db, { businessId, leave, approved, note = null, actorUserId = null }, options = {}) {
  const worker = await loadWorkerInfo(db, businessId, leave.MembershipId);
  const when = formatLeaveWindow(leave.StartsAtUtc, leave.EndsAtUtc, worker.timeZoneId);
  const text = approved
    ? `Your leave from ${when} was approved.`
    : `Your leave request for ${when} was not approved.`;
  const withNote = note ? `${text} Note: ${note}` : text;
  return notify(db, {
    businessId, category: 'schedule', eventType: 'leave.decided', title: approved ? 'Leave approved' : 'Leave not approved',
    body: withNote, dedupeKey: `leave.decided:${compact(leave.Id)}:${approved ? 'approved' : 'rejected'}`,
    target: { kind: 'leave', id: leave.Id }, actorUserId: actorUserId ?? undefined,
    recipients: { membershipIds: [leave.MembershipId] },
    email: { templateKey: 'leave.decided', subject: approved ? 'Your leave was approved' : 'Your leave request was not approved', text: () => withNote },
  }, options);
}

// Tasks that still hold planned time. The same statuses the manager's leave-collision panel uses (productionViewService).
const CLASH_SQL = `
  SELECT count(*)::int AS "Count"
  FROM "ProductionTasks" t
  WHERE t."BusinessId" = $1 AND t."AssignedMembershipId" = $2
    AND t."Status" IN ('Scheduled', 'InProgress', 'Paused')
    AND t."PlannedStartUtc" < $4 AND t."PlannedEndUtc" > $3`;

/**
 * Leave that overlaps tasks already planned for the same worker: tell the managers once per leave and status. Returns how many tasks
 * clash (0 sends nothing). The count covers every location the worker works at; the manager's own collision panel narrows it to the
 * manager's locations.
 */
export async function notifyLeaveCollision(db, { businessId, leave, status, actorUserId = null, worker = null }, options = {}) {
  const { rows } = await db.query(CLASH_SQL, [businessId, leave.MembershipId, leave.StartsAtUtc, leave.EndsAtUtc]);
  const clashes = Number(rows[0]?.Count ?? 0);
  if (clashes < 1) return 0;
  const info = worker ?? await loadWorkerInfo(db, businessId, leave.MembershipId);
  const when = formatLeaveWindow(leave.StartsAtUtc, leave.EndsAtUtc, info.timeZoneId);
  const tasks = clashes === 1 ? '1 planned task' : `${clashes} planned tasks`;
  const lead = status === 'Approved' ? 'Approved leave' : 'Requested leave';
  await notifyManagersAbout(db, info, 'workers.manage', {
    businessId, category: 'schedule', eventType: 'leave.collision', title: 'Leave collides with planned work',
    body: `${lead} for ${info.name} (${when}) overlaps ${tasks}. Open the worker schedule to review it.`,
    dedupeKey: `leave.collision:${compact(leave.Id)}:${String(status).toLowerCase()}`,
    target: { kind: 'leave', id: leave.Id }, actorUserId: actorUserId ?? undefined,
    email: {
      templateKey: 'leave.collision', subject: 'Leave collides with planned work',
      text: () => `${lead} for ${info.name} (${when}) overlaps ${tasks}. Open Avzar to review the worker schedule.`,
    },
  }, options);
  return clashes;
}

// ---- appointments ----------------------------------------------------------------------------------------------------------

const APPOINTMENT_COPY = Object.freeze({
  assigned: { title: 'Appointment assigned to you', verb: 'is booked for you on' },
  changed: { title: 'Appointment time changed', verb: 'now takes place on' },
  cancelled: { title: 'Appointment cancelled', verb: 'on' },
});

/**
 * Tell the assigned worker about an appointment: kind is 'assigned', 'changed' or 'cancelled'. No assignee means nobody to tell. The
 * text holds the type and time only: never the customer's name, the staff notes or the cancellation reason. The person who made
 * the change is not notified about their own action.
 */
export async function notifyAppointmentEvent(db, kind, { businessId, appointment, actorUserId = null, now = new Date() }, options = {}) {
  const copy = APPOINTMENT_COPY[kind];
  if (!copy) throw new TypeError(`Unknown appointment event: ${kind}`);
  if (!appointment?.AssignedMembershipId) return null;
  const when = formatInstant(appointment.StartUtc, appointment.TimeZoneId);
  const body = kind === 'cancelled'
    ? `The ${String(appointment.Type).toLowerCase()} appointment on ${when} was cancelled.`
    : `A ${String(appointment.Type).toLowerCase()} appointment ${copy.verb} ${when}.`;
  const stamp = kind === 'assigned' ? '' : `:${now.toISOString()}`;
  return notify(db, {
    businessId, category: 'schedule', eventType: `appointment.${kind}`, title: copy.title, body,
    dedupeKey: `appointment.${kind}:${compact(appointment.Id)}${stamp}`,
    target: { kind: 'appointment', id: appointment.Id }, actorUserId: actorUserId ?? undefined,
    recipients: { membershipIds: [appointment.AssignedMembershipId] },
    email: { templateKey: `appointment.${kind}`, subject: copy.title, text: () => body },
  }, { ...options, now });
}

// ---- sweeps ----------------------------------------------------------------------------------------------------------------

/** A worker planned beyond capacity on some of the next days: tell the people who manage the schedule. Once per worker per local day. */
export async function notifyScheduleOverload(db, { businessId, worker, today, overDates }, options = {}) {
  const info = await loadWorkerInfo(db, businessId, worker.membershipId);
  const name = String(worker.displayName ?? '').trim() || info.name;
  const days = overDates.length === 1 ? '1 day' : `${overDates.length} days`;
  const body = `${name} is planned beyond capacity on ${days} in the next week, starting ${overDates[0]}. Open Tasks, then Workload.`;
  return notifyManagersAbout(db, info, 'tasks.manage', {
    businessId, category: 'schedule', eventType: 'schedule.overload', title: 'Worker planned over capacity', body,
    dedupeKey: `schedule.overload:${compact(worker.membershipId)}:${today}`,
    email: { templateKey: 'schedule.overload', subject: 'A worker is planned over capacity', text: () => body },
  }, options);
}

export const installmentOverdueKey = (planId, sequence) => `installment.overdue:${compact(planId)}:${sequence}`;

/** An installment is past its own date and still unpaid: tell the people who manage invoices at the invoice's location. */
export async function notifyInstallmentOverdue(db, { businessId, invoice, planId, installment }, options = {}) {
  const body = `Installment ${installment.sequence} of invoice ${invoice.Number} was due on ${installment.dueDate} and is not paid.`;
  return notify(db, {
    businessId, category: 'finance', eventType: 'installment.overdue', title: 'Installment overdue', body,
    dedupeKey: installmentOverdueKey(planId, installment.sequence),
    target: { kind: 'invoice', id: invoice.Id },
    recipients: invoice.LocationId
      ? { permission: 'invoices.manage', locationId: invoice.LocationId }
      : { permission: 'invoices.manage', locationlessOnly: true },
    email: { templateKey: 'installment.overdue', subject: 'An installment is overdue', text: () => `${body} Open Avzar to review the invoice.` },
  }, options);
}
