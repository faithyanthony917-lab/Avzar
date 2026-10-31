// Step 16a: creating, moving and cancelling an appointment tells the assigned worker, inside the same transaction.
// A recording fake database answers by SQL substring; nobody is queued here, the recipient query itself is what is checked.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cancelAppointment, createAppointment, rescheduleAppointment } from '../src/auth/appointmentService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000010';
const locationId = '00000000-0000-4000-8000-000000000060';
const staffId = '00000000-0000-4000-8000-000000000040';
const apptId = '00000000-0000-4000-8000-000000000070';
const user = { businessId, userId };
const allowed = [locationId];
const none = { rows: [] };
const tx = (db) => async (_pool, callback) => callback(db);
const NOW = new Date('2026-11-01T08:00:00Z');
const future = (hours) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

function fakeDb({ assigned = staffId, status = 'Scheduled' } = {}) {
  const calls = [];
  const row = (values = []) => ({
    Id: apptId, Type: 'Fitting', CustomerId: customerId, OrderId: null, LocationId: locationId, AssignedMembershipId: assigned,
    StartUtc: values[7] ?? new Date(future(24)), EndUtc: values[8] ?? new Date(future(25)), TimeZoneId: 'UTC', Status: status, Notes: 'Staff note', CancellationReason: null,
  });
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('JOIN "AspNetUsers" appUser')) return none;
      if (sql.includes('FROM "Memberships" member')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Businesses"')) return { rows: [{ TimeZoneId: 'UTC' }] };
      if (sql.includes('FROM "Customers"')) return { rows: [{ Status: 'Active' }] };
      if (sql.includes('FROM "Locations"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('pg_advisory_xact_lock')) return none;
      if (sql.includes('FROM "Appointments" a')) return none;
      if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: '50' }] };
      if (sql.includes('INSERT INTO "UsageCounters"')) return { rows: [{ Count: '1' }] };
      if (sql.includes('INSERT INTO "Appointments"')) return { rows: [row(values)] };
      if (sql.includes('UPDATE "Appointments"')) return { rows: [row()] };
      if (sql.includes('FROM "Appointments"')) return { rows: [row()] };
      return none;
    },
  };
}
const told = (db) => db.calls.filter((call) => call.sql.includes('JOIN "AspNetUsers" appUser'));

describe('appointment notifications', () => {
  it('creating an appointment with an assignee tells that worker, and not the person who booked it', async () => {
    const db = fakeDb();
    await createAppointment({}, tx(db), user, { type: 'Fitting', customerId, locationId, assignedMembershipId: staffId, startAt: future(24), endAt: future(25) }, allowed, NOW);
    assert.equal(told(db).length, 1);
    const [query] = told(db);
    assert.deepEqual(query.values[1], [staffId]);
    assert.equal(query.values[2], 'schedule');
    assert.equal(query.values[6], userId, 'the person who made the change is excluded');
    const audit = db.calls.findIndex((call) => call.sql.includes('INSERT INTO "AuditLogs"'));
    assert.ok(audit >= 0 && db.calls.indexOf(query) > audit, 'the notice follows the audit row inside the same transaction');
  });

  it('an appointment with nobody assigned tells nobody', async () => {
    const db = fakeDb({ assigned: null });
    await createAppointment({}, tx(db), user, { type: 'Fitting', customerId, locationId, startAt: future(24), endAt: future(25) }, allowed, NOW);
    assert.equal(told(db).length, 0);
  });

  it('moving it tells the assigned worker', async () => {
    const db = fakeDb();
    await rescheduleAppointment({}, tx(db), user, apptId, { startAt: future(48), endAt: future(49) }, allowed, NOW);
    assert.equal(told(db).length, 1);
    assert.deepEqual(told(db)[0].values[1], [staffId]);
  });

  it('cancelling it tells the assigned worker, and the reason stays out of the notice', async () => {
    const db = fakeDb();
    await cancelAppointment({}, tx(db), user, apptId, 'Customer called to cancel', allowed, NOW);
    assert.equal(told(db).length, 1);
    assert.deepEqual(told(db)[0].values[1], [staffId]);
    assert.ok(!JSON.stringify(told(db)).includes('Customer called'));
  });

  it('a conflict or a refused change sends nothing', async () => {
    const db = fakeDb({ status: 'Completed' });
    await assert.rejects(() => cancelAppointment({}, tx(db), user, apptId, 'Too late', allowed, NOW), (error) => error.code === 'appointment_closed');
    assert.equal(told(db).length, 0);
  });
});
