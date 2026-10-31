// Step 16a: the staff notifications for leave, appointments, an overloaded worker and an overdue installment.
// A recording fake database answers by SQL substring; the real SQL runs in test/db/staffNotifications.integration.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInstant, notifyAppointmentEvent, notifyInstallmentOverdue, notifyLeaveCollision, notifyLeaveDecided, notifyLeaveRequested,
  notifyScheduleOverload,
} from '../../src/notifications/staffEvents.js';

const business = '00000000-0000-4000-8000-0000000000b1';
const worker = '00000000-0000-4000-8000-0000000000a1';
const manager = '00000000-0000-4000-8000-0000000000a2';
const actor = '00000000-0000-4000-8000-0000000000a3';
const leaveId = '00000000-0000-4000-8000-0000000000c1';
const apptId = '00000000-0000-4000-8000-0000000000c2';
const invoiceId = '00000000-0000-4000-8000-0000000000c3';
const planId = '00000000-0000-4000-8000-0000000000c4';
const loc1 = '00000000-0000-4000-8000-0000000000d1';
const loc2 = '00000000-0000-4000-8000-0000000000d2';
const NOW = new Date('2026-11-12T08:00:00Z');
const silent = { error() {}, info() {} };
const leave = { Id: leaveId, MembershipId: worker, StartsAtUtc: new Date('2026-11-20T08:00:00Z'), EndsAtUtc: new Date('2026-11-21T16:00:00Z'), Reason: 'Private reason' };

function fakeDb({ locationIds = [loc1], clashes = 0, name = 'Ada Obi', people = [{ Id: manager, DisplayName: 'Boss', Email: 'boss@example.test', TimeZoneId: 'UTC' }] } = {}) {
  const calls = [];
  const outbox = [];
  const db = {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('array_agg')) return { rows: [{ DisplayName: name, TimeZoneId: 'Africa/Lagos', LocationIds: locationIds }] };
      if (sql.includes('FROM "ProductionTasks" t')) return { rows: [{ Count: clashes }] };
      if (sql.includes('FROM "Memberships" m')) return { rows: people };
      if (sql.includes('INSERT INTO "NotificationOutbox"')) {
        const duplicate = outbox.some((job) => job.RecipientMembershipId === values[2] && job.DeduplicationKey === values[9]);
        if (duplicate) return { rowCount: 0, rows: [] };
        const job = {
          Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4], Title: values[5], Body: values[6],
          TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9], InAppEnabled: values[10], EmailToAddress: values[11],
          Status: 'Pending', CreatedAtUtc: values[19],
        };
        outbox.push(job);
        return { rowCount: 1, rows: [job] };
      }
      if (sql.includes('INSERT INTO "Notifications"')) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}
const rows = (db) => db.calls.filter((call) => call.sql.includes('INSERT INTO "Notifications"')).map((call) => ({
  recipient: call.values[2], category: call.values[3], eventType: call.values[4], title: call.values[5], body: call.values[6],
  targetKind: call.values[7], targetId: call.values[8], dedupeKey: call.values[9],
}));
const recipientQueries = (db) => db.calls.filter((call) => call.sql.includes('FROM "Memberships" m') && !call.sql.includes('array_agg'));
const opts = { now: NOW, log: silent };

describe('formatInstant', () => {
  it('writes the time in the named zone and falls back to UTC for an unknown one', () => {
    assert.equal(formatInstant('2026-11-12T13:30:00Z', 'Africa/Lagos'), '12 Nov 2026, 14:30');
    assert.equal(formatInstant('2026-11-12T13:30:00Z', 'Not/AZone'), '12 Nov 2026, 13:30');
    assert.equal(formatInstant('not a date', 'UTC'), '');
  });
});

describe('leave notifications', () => {
  it('a request goes to the leave managers of every location the worker is at, with the name and dates but never the reason', async () => {
    const db = fakeDb({ locationIds: [loc1, loc2] });
    await notifyLeaveRequested(db, { businessId: business, leave, actorUserId: actor }, opts);
    const queries = recipientQueries(db);
    assert.equal(queries.length, 2);
    assert.deepEqual(queries.map((call) => call.values[4]), [loc1, loc2]);
    assert.ok(queries.every((call) => call.values[3] === 'workers.manage' && call.values[2] === 'schedule' && call.values[6] === actor));
    const [first] = rows(db);
    assert.equal(first.eventType, 'leave.requested');
    assert.equal(first.targetKind, 'leave');
    assert.equal(first.targetId, leaveId);
    assert.equal(first.dedupeKey, `leave.requested:${leaveId.replaceAll('-', '')}`);
    assert.match(first.body, /Ada Obi asked for leave from 20 Nov 2026, 09:00 to 21 Nov 2026, 17:00/);
    assert.ok(!JSON.stringify(rows(db)).includes('Private reason'));
  });

  it('a manager at both locations is told once, because the second location repeats the same deduplication key', async () => {
    const db = fakeDb({ locationIds: [loc1, loc2] });
    await notifyLeaveRequested(db, { businessId: business, leave }, opts);
    assert.equal(rows(db).length, 1);
  });

  it('a worker with no location goes to the owner and to people who see every location', async () => {
    const db = fakeDb({ locationIds: [] });
    await notifyLeaveRequested(db, { businessId: business, leave }, opts);
    const [query] = recipientQueries(db);
    assert.equal(query.values[4], null);
    assert.equal(query.values[8], true);
  });

  it('a decision goes to the worker alone, with the manager note, and approvals and refusals read differently', async () => {
    const approved = fakeDb();
    await notifyLeaveDecided(approved, { businessId: business, leave, approved: true, note: 'Enjoy', actorUserId: actor }, opts);
    assert.deepEqual(recipientQueries(approved)[0].values[1], [worker]);
    const [yes] = rows(approved);
    assert.equal(yes.title, 'Leave approved');
    assert.match(yes.body, /was approved\. Note: Enjoy$/);
    assert.equal(yes.dedupeKey, `leave.decided:${leaveId.replaceAll('-', '')}:approved`);

    const refused = fakeDb();
    await notifyLeaveDecided(refused, { businessId: business, leave, approved: false, actorUserId: actor }, opts);
    const [no] = rows(refused);
    assert.equal(no.title, 'Leave not approved');
    assert.match(no.body, /was not approved\.$/);
    assert.notEqual(no.dedupeKey, yes.dedupeKey);
  });

  it('a collision is announced only when planned tasks overlap, with the count', async () => {
    const none = fakeDb({ clashes: 0 });
    assert.equal(await notifyLeaveCollision(none, { businessId: business, leave, status: 'Pending' }, opts), 0);
    assert.equal(recipientQueries(none).length, 0);

    const some = fakeDb({ clashes: 2 });
    assert.equal(await notifyLeaveCollision(some, { businessId: business, leave, status: 'Pending' }, opts), 2);
    const [row] = rows(some);
    assert.equal(row.eventType, 'leave.collision');
    assert.match(row.body, /^Requested leave for Ada Obi .* overlaps 2 planned tasks\./);
    assert.equal(row.dedupeKey, `leave.collision:${leaveId.replaceAll('-', '')}:pending`);

    const one = fakeDb({ clashes: 1 });
    await notifyLeaveCollision(one, { businessId: business, leave, status: 'Approved' }, opts);
    assert.match(rows(one)[0].body, /^Approved leave .* overlaps 1 planned task\./);
    assert.ok(rows(one)[0].dedupeKey.endsWith(':approved'));
  });

  it('counts clashes only for the worker and window asked about, in planned statuses', async () => {
    const db = fakeDb({ clashes: 1 });
    await notifyLeaveCollision(db, { businessId: business, leave, status: 'Pending' }, opts);
    const query = db.calls.find((call) => call.sql.includes('FROM "ProductionTasks" t'));
    assert.deepEqual(query.values, [business, worker, leave.StartsAtUtc, leave.EndsAtUtc]);
    assert.match(query.sql, /'Scheduled', 'InProgress', 'Paused'/);
  });
});

describe('appointment notifications', () => {
  const appointment = { Id: apptId, Type: 'Fitting', AssignedMembershipId: worker, StartUtc: new Date('2026-11-12T13:30:00Z'), TimeZoneId: 'Africa/Lagos', Notes: 'Secret note', CustomerId: 'c' };

  it('goes to the assigned worker only, with type and time and never the notes', async () => {
    const db = fakeDb();
    await notifyAppointmentEvent(db, 'assigned', { businessId: business, appointment, actorUserId: actor, now: NOW }, { log: silent });
    const [row] = rows(db);
    assert.equal(row.eventType, 'appointment.assigned');
    assert.equal(row.targetKind, 'appointment');
    assert.equal(row.body, 'A fitting appointment is booked for you on 12 Nov 2026, 14:30.');
    assert.equal(row.dedupeKey, `appointment.assigned:${apptId.replaceAll('-', '')}`);
    assert.deepEqual(recipientQueries(db)[0].values[1], [worker]);
    assert.equal(recipientQueries(db)[0].values[6], actor);
    assert.ok(!JSON.stringify(rows(db)).includes('Secret note'));
  });

  it('a change and a cancellation carry the moment they happened so a rebooked appointment can be announced again', async () => {
    const changed = fakeDb();
    await notifyAppointmentEvent(changed, 'changed', { businessId: business, appointment, now: NOW }, { log: silent });
    assert.equal(rows(changed)[0].title, 'Appointment time changed');
    assert.ok(rows(changed)[0].dedupeKey.endsWith(`:${NOW.toISOString()}`));

    const cancelled = fakeDb();
    await notifyAppointmentEvent(cancelled, 'cancelled', { businessId: business, appointment: { ...appointment, CancellationReason: 'Customer asked' }, now: NOW }, { log: silent });
    assert.equal(rows(cancelled)[0].body, 'The fitting appointment on 12 Nov 2026, 14:30 was cancelled.');
    assert.ok(!JSON.stringify(rows(cancelled)).includes('Customer asked'));
  });

  it('an appointment nobody is assigned to tells nobody, and an unknown kind is refused', async () => {
    const db = fakeDb();
    assert.equal(await notifyAppointmentEvent(db, 'assigned', { businessId: business, appointment: { ...appointment, AssignedMembershipId: null }, now: NOW }), null);
    assert.equal(db.calls.length, 0);
    await assert.rejects(() => notifyAppointmentEvent(db, 'moved', { businessId: business, appointment, now: NOW }), TypeError);
  });
});

describe('sweep notifications', () => {
  it('an overloaded worker goes to the schedule managers once per worker per local day', async () => {
    const db = fakeDb({ locationIds: [loc1] });
    await notifyScheduleOverload(db, { businessId: business, worker: { membershipId: worker, displayName: 'Ada Obi' }, today: '2026-11-12', overDates: ['2026-11-13', '2026-11-14'] }, opts);
    const [query] = recipientQueries(db);
    assert.equal(query.values[3], 'tasks.manage');
    assert.equal(query.values[4], loc1);
    const [row] = rows(db);
    assert.equal(row.eventType, 'schedule.overload');
    assert.equal(row.targetKind, null);
    assert.equal(row.body, 'Ada Obi is planned beyond capacity on 2 days in the next week, starting 2026-11-13. Open Tasks, then Workload.');
    assert.equal(row.dedupeKey, `schedule.overload:${worker.replaceAll('-', '')}:2026-11-12`);
  });

  it('an overdue installment goes to the invoice managers at the invoice location, or to people who see every location when it has none', async () => {
    const installment = { sequence: 2, dueDate: '2026-11-10' };
    const located = fakeDb();
    await notifyInstallmentOverdue(located, { businessId: business, invoice: { Id: invoiceId, Number: 'INV-2026-0007', LocationId: loc1 }, planId, installment }, opts);
    assert.equal(recipientQueries(located)[0].values[3], 'invoices.manage');
    assert.equal(recipientQueries(located)[0].values[4], loc1);
    const [row] = rows(located);
    assert.equal(row.eventType, 'installment.overdue');
    assert.equal(row.targetKind, 'invoice');
    assert.equal(row.targetId, invoiceId);
    assert.equal(row.body, 'Installment 2 of invoice INV-2026-0007 was due on 2026-11-10 and is not paid.');
    assert.equal(row.dedupeKey, `installment.overdue:${planId.replaceAll('-', '')}:2`);

    const locationless = fakeDb();
    await notifyInstallmentOverdue(locationless, { businessId: business, invoice: { Id: invoiceId, Number: 'INV-1', LocationId: null }, planId, installment }, opts);
    assert.equal(recipientQueries(locationless)[0].values[4], null);
    assert.equal(recipientQueries(locationless)[0].values[8], true);
  });
});
