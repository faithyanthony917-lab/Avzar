// Real PostgreSQL coverage for appointments, migration of existing fittings, and reminder persistence.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {
  cancelAppointment, createAppointment, listAppointments, rescheduleAppointment, setAppointmentStatus,
} from '../../src/auth/appointmentService.js';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { dispatchAppointmentRemindersOnce } from '../../src/notifications/appointmentReminderWorker.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const NOW = new Date();
const at = (days, hours = 10) => new Date(NOW.getTime() + days * 86_400_000 + hours * 3_600_000);

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

describe('appointments on PostgreSQL', { skip: !url }, () => {
  let db;
  let pool;
  const ids = {};
  let owner;
  let worker;
  let workerUser;
  let otherBusinessId;
  let otherCustomerId;
  let otherLocationId;

  async function insertBusiness(name) {
    const id = randomUUID();
    await pool.query(`INSERT INTO "Businesses" ("Id","Name","IsActive","TimeZoneId","CurrencyCode","CreatedAtUtc") VALUES ($1,$2,TRUE,'America/New_York','NGN',now())`, [id, name]);
    return id;
  }

  async function insertMember(businessId, label, isOwner = false) {
    const userId = randomUUID();
    const membershipId = randomUUID();
    await pool.query(`INSERT INTO "AspNetUsers" ("Id","Email","NormalizedEmail","UserName","NormalizedUserName","FullName","EmailConfirmed","PhoneNumberConfirmed","TwoFactorEnabled","LockoutEnabled","AccessFailedCount","SecurityStamp","ConcurrencyStamp","CreatedAtUtc") VALUES ($1,$2,$3,$2,$3,$4,TRUE,FALSE,FALSE,FALSE,0,'s','c',now())`, [userId, `${label}@example.test`, `${label}@example.test`.toUpperCase(), label]);
    await pool.query(`INSERT INTO "Memberships" ("Id","BusinessId","CreatedAtUtc","DisplayName","IsOwner","Status","UserId") VALUES ($1,$2,now(),$3,$4,0,$5)`, [membershipId, businessId, label, isOwner, userId]);
    return { userId, membershipId };
  }

  async function insertLocation(businessId, name) {
    const id = randomUUID();
    await pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,$3,TRUE,now())`, [id, businessId, name]);
    return id;
  }

  async function insertCustomer(businessId, name) {
    const id = randomUUID();
    await pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),$3,'Active')`, [id, businessId, name]);
    return id;
  }

  async function makeAppointment({ customerId = ids.customerA, locationId = ids.locationA, assignedMembershipId = worker.membershipId,
    start = at(4), end = new Date(start.getTime() + 30 * 60_000), type = 'Consultation', orderId = null,
    allowedLocations = [ids.locationA] } = {}) {
    return createAppointment(pool, transaction, owner, {
      type, customerId, locationId, assignedMembershipId, startAt: start.toISOString(), endAt: end.toISOString(), orderId, notes: 'Appointment integration test',
    }, allowedLocations, NOW);
  }

  before(async () => {
    db = await createTempDatabase(url, 'avzar_appointments');
    pool = db.pool;
    await migrate(pool, MIGRATIONS_DIR, quiet);
    await syncPlans(pool);
    await pool.query(`UPDATE "PlanEntitlements" SET "Value" = '100'
      WHERE "Key" = 'appointments.monthly.max' AND "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = 'free')`);
    ids.businessA = await insertBusiness('Appointment tenant A');
    otherBusinessId = await insertBusiness('Appointment tenant B');
    const ownerMember = await insertMember(ids.businessA, 'appointment-owner', true);
    owner = { userId: ownerMember.userId, businessId: ids.businessA, isOwner: true, permissions: ['locations.all'] };
    workerUser = await insertMember(ids.businessA, 'appointment-worker');
    worker = workerUser;
    ids.locationA = await insertLocation(ids.businessA, 'Main studio');
    ids.locationB = await insertLocation(ids.businessA, 'Other studio');
    otherLocationId = await insertLocation(otherBusinessId, 'Other tenant studio');
    ids.customerA = await insertCustomer(ids.businessA, 'Appointment customer A');
    ids.customerB = await insertCustomer(ids.businessA, 'Appointment customer B');
    otherCustomerId = await insertCustomer(otherBusinessId, 'Other tenant customer');
    await pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`, [worker.membershipId, ids.locationA, ids.businessA]);
    await pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`, [worker.membershipId, ids.locationB, ids.businessA]);
  });

  after(async () => { await db?.drop(); });

  it('creates with business time-zone snapshot and persists two future reminders', async () => {
    const appointment = await makeAppointment({ start: at(3) });
    assert.equal(appointment.type, 'Consultation');
    assert.equal(appointment.timeZoneId, 'America/New_York');
    assert.equal(appointment.status, 'Scheduled');
    const reminders = await pool.query(`SELECT "OffsetMinutes", "DueAtUtc", "Status" FROM "AppointmentReminders" WHERE "BusinessId" = $1 AND "AppointmentId" = $2 ORDER BY "OffsetMinutes" DESC`, [ids.businessA, appointment.id]);
    assert.deepEqual(reminders.rows.map((row) => Number(row.OffsetMinutes)), [1440, 120]);
    assert.ok(reminders.rows.every((row) => row.Status === 'Pending' && new Date(row.DueAtUtc) < new Date(appointment.startUtc)));
  });

  it('enforces the appointment duration bounds in the service', async () => {
    const start = at(5);
    await assert.rejects(makeAppointment({ start, end: new Date(start.getTime() + 4 * 60_000) }), { code: 'invalid_appointment_duration' });
    await assert.rejects(makeAppointment({ start, end: new Date(start.getTime() + 481 * 60_000) }), { code: 'invalid_appointment_duration' });
  });

  it('blocks customer and staff overlaps across locations while allowing back-to-back bookings', async () => {
    const start = at(8);
    const first = await makeAppointment({ start });
    await assert.rejects(makeAppointment({ customerId: ids.customerB, locationId: ids.locationB, start, allowedLocations: null }), { code: 'appointment_conflict' });
    await assert.rejects(makeAppointment({ customerId: ids.customerA, locationId: ids.locationB, assignedMembershipId: null, start, allowedLocations: null }), { code: 'appointment_conflict' });
    const adjacent = await makeAppointment({ customerId: ids.customerB, start: new Date(Date.parse(first.endUtc)) });
    assert.equal(adjacent.status, 'Scheduled');

    const hiddenStart = at(9);
    await makeAppointment({ customerId: ids.customerB, locationId: ids.locationB, start: hiddenStart, allowedLocations: null });
    await assert.rejects(makeAppointment({ customerId: ids.customerA, locationId: ids.locationA, start: hiddenStart }),
      (error) => error.code === 'appointment_conflict' && error.extensions?.conflicts?.length === 0);
  });

  it('serializes concurrent overlapping creates with a per-customer/staff advisory lock', async () => {
    const start = at(12);
    const requests = await Promise.allSettled([
      makeAppointment({ customerId: ids.customerA, start }),
      makeAppointment({ customerId: ids.customerB, start }),
    ]);
    assert.equal(requests.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(requests.filter((result) => result.status === 'rejected' && result.reason?.code === 'appointment_conflict').length, 1);
  });

  it('scopes list results by business and allowed locations', async () => {
    await makeAppointment({ locationId: ids.locationA, start: at(16) });
    const otherLocationAppointment = await createAppointment(pool, transaction, owner, {
      type: 'Delivery', customerId: ids.customerB, locationId: ids.locationB, assignedMembershipId: null,
      startAt: at(17).toISOString(), endAt: new Date(at(17).getTime() + 30 * 60_000).toISOString(),
    }, null, NOW);
    assert.equal(otherLocationAppointment.locationId, ids.locationB);
    const visible = await listAppointments(pool, owner, { page: 1, pageSize: 100 }, [ids.locationA]);
    assert.ok(visible.items.every((item) => item.locationId === ids.locationA));
    const hiddenTenant = await listAppointments(pool, { ...owner, businessId: otherBusinessId }, { page: 1, pageSize: 100 }, null);
    assert.deepEqual(hiddenTenant.items, []);
  });

  it('cancellation requires a reason; reopen runs the same conflict check; reschedule does not consume another entitlement', async () => {
    const start = at(20);
    const appointment = await makeAppointment({ start });
    const before = await pool.query(`SELECT "Count" FROM "UsageCounters" WHERE "BusinessId" = $1 AND "Key" = 'appointments.monthly.max' AND "PeriodStartUtc" = date_trunc('month', now())`, [ids.businessA]);
    await assert.rejects(cancelAppointment(pool, transaction, owner, appointment.id, '', [ids.locationA], NOW), { code: 'invalid_cancellation_reason' });
    await cancelAppointment(pool, transaction, owner, appointment.id, 'Customer requested a new date.', [ids.locationA], NOW);
    const blocker = await makeAppointment({ customerId: ids.customerB, start });
    await assert.rejects(setAppointmentStatus(pool, transaction, owner, appointment.id, 'Scheduled', [ids.locationA], NOW), { code: 'appointment_conflict' });
    await cancelAppointment(pool, transaction, owner, blocker.id, 'Clear the slot for reopen test.', [ids.locationA], NOW);
    await setAppointmentStatus(pool, transaction, owner, appointment.id, 'Scheduled', [ids.locationA], NOW);
    const reopened = await rescheduleAppointment(pool, transaction, owner, appointment.id, {
      startAt: at(21).toISOString(), endAt: new Date(at(21).getTime() + 30 * 60_000).toISOString(),
    }, [ids.locationA], NOW);
    assert.equal(reopened.status, 'Scheduled');
    const after = await pool.query(`SELECT "Count" FROM "UsageCounters" WHERE "BusinessId" = $1 AND "Key" = 'appointments.monthly.max' AND "PeriodStartUtc" = date_trunc('month', now())`, [ids.businessA]);
    assert.equal(Number(after.rows[0].Count), Number(before.rows[0].Count) + 1, 'reschedule and reopening do not consume entitlement');
  });

  it('preserves the booking-time business zone snapshot during reschedule', async () => {
    const appointment = await makeAppointment({ customerId: ids.customerB, start: at(22) });
    await pool.query(`UPDATE "Businesses" SET "TimeZoneId" = 'UTC' WHERE "Id" = $1`, [ids.businessA]);
    const start = at(23);
    const updated = await rescheduleAppointment(pool, transaction, owner, appointment.id, {
      startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    }, [ids.locationA], NOW);
    assert.equal(updated.timeZoneId, 'America/New_York');
    await pool.query(`UPDATE "Businesses" SET "TimeZoneId" = 'America/New_York' WHERE "Id" = $1`, [ids.businessA]);
  });

  it('rejects cross-business references through composite foreign keys', async () => {
    await assert.rejects(pool.query(`INSERT INTO "Appointments" ("Id","BusinessId","Type","CustomerId","LocationId","StartUtc","EndUtc","TimeZoneId","Status","CreatedAtUtc") VALUES ($1,$2,'Fitting',$3,$4,$5,$6,'UTC','Scheduled',now())`, [randomUUID(), ids.businessA, otherCustomerId, ids.locationA, at(25), at(25, 11)]), /FK_Appointments_Customers_CustomerId_BusinessId/);
    await assert.rejects(pool.query(`INSERT INTO "Appointments" ("Id","BusinessId","Type","CustomerId","LocationId","AssignedMembershipId","StartUtc","EndUtc","TimeZoneId","Status","CreatedAtUtc") VALUES ($1,$2,'Fitting',$3,$4,$5,$6,$7,'UTC','Scheduled',now())`, [randomUUID(), otherBusinessId, otherCustomerId, otherLocationId, worker.membershipId, at(25), at(25, 11)]), /FK_Appointments_Memberships_AssignedMembershipId_BusinessId/);
    const appointment = await makeAppointment({ customerId: ids.customerA, start: at(26) });
    await assert.rejects(pool.query(`INSERT INTO "AppointmentReminders" ("Id","BusinessId","AppointmentId","RecipientMembershipId","AppointmentStartUtc","OffsetMinutes","DueAtUtc","NextAttemptUtc","CreatedAtUtc") VALUES ($1,$2,$3,$4,$5,1440,$6,$6,$6)`, [randomUUID(), otherBusinessId, appointment.id, worker.membershipId, appointment.startUtc, new Date(Date.parse(appointment.startUtc) - 86_400_000)]), /FK_AppointmentReminders_Appointments_AppointmentId_BusinessId/);
  });

  it('delivers due reminders through the notification outbox and suppresses cancelled or started appointments', async () => {
    const dueStart = at(2);
    const dueAppointment = await makeAppointment({ start: dueStart });
    const reminderDue = new Date(dueStart.getTime() - 24 * 60 * 60_000 + 60_000);
    const delivered = await dispatchAppointmentRemindersOnce(pool, { now: reminderDue, log: quiet });
    assert.equal(delivered.sent, 1);
    const notification = await pool.query(`SELECT "TargetKind","TargetId","Body" FROM "Notifications"
      WHERE "BusinessId" = $1 AND "EventType" = 'appointment.reminder' AND "TargetId" = $2`, [ids.businessA, dueAppointment.id]);
    assert.equal(notification.rows.length, 1);
    assert.equal(notification.rows[0].TargetKind, 'appointment');
    assert.match(notification.rows[0].Body, /Consultation appointment in 24 hours/);

    const cancelledStart = at(4);
    const cancelledAppointment = await makeAppointment({ customerId: ids.customerB, start: cancelledStart });
    await cancelAppointment(pool, transaction, owner, cancelledAppointment.id, 'Customer requested cancellation.', [ids.locationA], NOW);
    const cancelledDue = new Date(cancelledStart.getTime() - 24 * 60 * 60_000 + 60_000);
    const cancelledRun = await dispatchAppointmentRemindersOnce(pool, { now: cancelledDue, log: quiet });
    assert.equal(cancelledRun.sent, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "Notifications"
      WHERE "BusinessId" = $1 AND "EventType" = 'appointment.reminder' AND "TargetId" = $2`, [ids.businessA, cancelledAppointment.id])).rows[0].n, 0);

    const startedStart = at(6);
    const startedAppointment = await makeAppointment({ customerId: ids.customerB, start: startedStart });
    const claimedBeforeStart = new Date(startedStart.getTime() - 24 * 60 * 60_000 + 60_000);
    const afterStart = await dispatchAppointmentRemindersOnce(pool, {
      now: claimedBeforeStart, clock: () => new Date(startedStart.getTime() + 1), log: quiet,
    });
    assert.equal(afterStart.sent, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "AppointmentReminders"
      WHERE "BusinessId" = $1 AND "AppointmentId" = $2 AND "Status" = 'Cancelled'`, [ids.businessA, startedAppointment.id])).rows[0].n, 2);
  });
});

describe('appointment migration preserves existing fitting IDs on PostgreSQL', { skip: !url }, () => {
  let db;
  let oldMigrationsDir;
  let ids;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_fitting_copy');
    oldMigrationsDir = await mkdtemp(path.join(os.tmpdir(), 'avzar-migrations-0020-'));
    for (const name of (await readdir(MIGRATIONS_DIR)).filter((file) => /^\d{4}_.+\.sql$/.test(file) && file < '0021_appointments.sql')) {
      await copyFile(path.join(MIGRATIONS_DIR, name), path.join(oldMigrationsDir, name));
    }
    await migrate(db.pool, oldMigrationsDir, quiet);
    const businessId = randomUUID();
    const customerId = randomUUID();
    const locationId = randomUUID();
    const fittingId = randomUUID();
    await db.pool.query(`INSERT INTO "Businesses" ("Id","Name","IsActive","TimeZoneId","CurrencyCode","CreatedAtUtc") VALUES ($1,'Legacy fittings',TRUE,'America/New_York','NGN',now())`, [businessId]);
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Legacy customer','Active')`, [customerId, businessId]);
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Legacy location',TRUE,now())`, [locationId, businessId]);
    await db.pool.query(`INSERT INTO "Fittings" ("Id","BusinessId","CreatedAtUtc","CustomerId","DurationMinutes","LocationId","ScheduledAtUtc","Status","Notes") VALUES ($1,$2,now(),$3,45,$4,'2030-11-03T06:30:00Z','Scheduled','Copied intact')`, [fittingId, businessId, customerId, locationId]);
    ids = { businessId, customerId, locationId, fittingId };
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
  });

  after(async () => { await db?.drop(); await rm(oldMigrationsDir, { recursive: true, force: true }); });

  it('copies the same fitting ID, interval, and business time zone while retaining Fittings', async () => {
    const { rows } = await db.pool.query(`SELECT "Id","Type","CustomerId","LocationId","StartUtc","EndUtc","TimeZoneId","Notes" FROM "Appointments" WHERE "BusinessId" = $1`, [ids.businessId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Id, ids.fittingId);
    assert.equal(rows[0].Type, 'Fitting');
    assert.equal(rows[0].CustomerId, ids.customerId);
    assert.equal(rows[0].LocationId, ids.locationId);
    assert.equal(new Date(rows[0].StartUtc).toISOString(), '2030-11-03T06:30:00.000Z');
    assert.equal(new Date(rows[0].EndUtc).toISOString(), '2030-11-03T07:15:00.000Z');
    assert.equal(rows[0].TimeZoneId, 'America/New_York');
    assert.equal(rows[0].Notes, 'Copied intact');
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "Fittings" WHERE "Id" = $1', [ids.fittingId])).rows[0].n, 1);
  });
});