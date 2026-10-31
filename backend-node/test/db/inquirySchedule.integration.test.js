// Step-14: POST /api/inquiries/:id/schedule (a storefront booking request becomes an appointment) over HTTP on real PostgreSQL,
// run through a NOSUPERUSER, NOBYPASSRLS role like the staging database. Fixtures use the superuser pool.
// Checks: both permissions needed, another business gets 404 and nothing changes, a location the user may not use is refused,
// one transaction (a conflict leaves no customer, no link and no audit row behind), an existing customer is reused, a second
// attempt is a 409, and only a booking request can be scheduled. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, firstLocationId, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe('schedule a booking request over HTTP on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let manageOnly; let fittingsOnly; let noLocation; let limited; let locationTwo; let locationId; let ownerMembership; let storefrontId;

  const interval = (days, minutes = 30) => {
    const start = new Date(Date.now() + days * DAY);
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + minutes * 60_000).toISOString() };
  };
  const body = (days, extra = {}) => ({ type: 'Fitting', locationId, assignedMembershipId: ownerMembership, ...interval(days), ...extra });
  const addInquiry = async ({ kind = 'Appointment', email, businessId = owner.businessId, sfId = storefrontId } = {}) => {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO "Inquiries" ("Id","BusinessId","StorefrontId","Kind","Status","Name","Email","Message","PreferredDate","CreatedAtUtc")
      VALUES ($1,$2,$3,$4,'New','Booking Person',$5,'I would like a fitting.', CURRENT_DATE + 3, now())`, [id, businessId, sfId, kind, email]);
    return id;
  };
  const inquiryRow = async (id) => (await db.pool.query(`SELECT "Status","AppointmentId", xmin::text AS version FROM "Inquiries" WHERE "Id" = $1`, [id])).rows[0];
  const count = async (sql, params) => Number((await db.pool.query(sql, params)).rows[0].n);
  const appointments = () => count(`SELECT count(*) AS n FROM "Appointments" WHERE "BusinessId" = $1`, [owner.businessId]);
  const customersWith = (email) => count(`SELECT count(*) AS n FROM "Customers" WHERE "BusinessId" = $1 AND "NormalizedEmail" = $2`, [owner.businessId, email]);
  const auditCount = (action, entityId) => count(`SELECT count(*) AS n FROM "AuditLogs" WHERE "Action" = $1 AND "EntityId" = $2`, [action, entityId]);
  const schedule = (who, id, payload) => api.call('POST', `/api/inquiries/${id}/schedule`, { token: who?.token, body: payload });

  before(async () => {
    db = await createTempDatabase(url, 'avzar_inq_sched');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'is-owner');
    other = await signUp(api, 'is-other');
    // The Starter plan allows 3 accounts; this suite needs the owner and three staff, so lift only that one limit.
    await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
      VALUES ($1,$2,now(),'users.max','test fixture: more staff than the plan allows','unlimited')`, [randomUUID(), owner.businessId]);
    manageOnly = await addStaff(api, db, owner, 'is-manage', ['inquiries.view', 'inquiries.manage']);
    fittingsOnly = await addStaff(api, db, owner, 'is-fittings', ['fittings.manage']);
    noLocation = await addStaff(api, db, owner, 'is-noloc', ['inquiries.view', 'inquiries.manage', 'fittings.manage']);
    locationId = await firstLocationId(db, owner.businessId);
    // Step-14b: a second location, and a user who may use only the first one.
    locationTwo = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Second shop',true,now())`, [locationTwo, owner.businessId]);
    limited = await addStaff(api, db, owner, 'is-limited', ['inquiries.view', 'inquiries.manage', 'fittings.manage']);
    await db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId")
      SELECT m."Id", $3, $2 FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId" WHERE m."BusinessId" = $2 AND u."Email" = $1`, [limited.email, owner.businessId, locationId]);
    ownerMembership = (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
      WHERE m."BusinessId" = $1 AND m."Status" = 0 AND u."Email" = $2`, [owner.businessId, owner.email])).rows[0].Id;
    storefrontId = randomUUID();
    await db.pool.query(`INSERT INTO "Storefronts" ("Id","BusinessId","Slug","Name","Status","TemplateKey","DraftJson","DraftRevision","AllowSearchIndexing",
      "WorkflowBooking","WorkflowContact","WorkflowCustomOrder","WorkflowInquiry","CreatedAtUtc")
      VALUES ($1,$2,$3,'Shop','Draft','luxury','{}',1,false,true,true,true,true,now())`, [storefrontId, owner.businessId, `is-${randomUUID().slice(0, 8)}`]);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('needs a sign-in and both inquiries.manage and fittings.manage', async () => {
    const id = await addInquiry({ email: 'perm@example.test' });
    const before0 = await inquiryRow(id);
    assert.equal((await schedule(undefined, id, body(20))).status, 401);
    assert.equal((await schedule(manageOnly, id, body(20))).status, 403);
    assert.equal((await schedule(fittingsOnly, id, body(20))).status, 403);
    assert.deepEqual(await inquiryRow(id), before0);
    assert.equal(await customersWith('perm@example.test'), 0);
  });

  it('another business gets 404 and nothing is written', async () => {
    const id = await addInquiry({ email: 'cross@example.test' });
    const before0 = await inquiryRow(id);
    const appointmentsBefore = await appointments();
    const response = await schedule(other, id, body(21));
    assert.equal(response.status, 404, response.text);
    assert.equal(response.body.code, 'inquiry_not_found');
    assert.deepEqual(await inquiryRow(id), before0);
    assert.equal(await appointments(), appointmentsBefore);
    assert.equal(await customersWith('cross@example.test'), 0);
  });

  it('a malformed ID is a 404 and an unknown field or a bad interval is a 400', async () => {
    assert.equal((await schedule(owner, 'not-a-uuid', body(22))).status, 404);
    const id = await addInquiry({ email: 'bad@example.test' });
    const before0 = await inquiryRow(id);
    assert.equal((await schedule(owner, id, { ...body(22), customerId: randomUUID() })).status, 400);
    const backwards = await schedule(owner, id, { ...body(22), endAt: interval(22).startAt, startAt: interval(22, 60).endAt });
    assert.equal(backwards.status, 400, backwards.text);
    assert.deepEqual(await inquiryRow(id), before0);
    assert.equal(await customersWith('bad@example.test'), 0);
  });

  it('only a booking request can be scheduled', async () => {
    const id = await addInquiry({ kind: 'Inquiry', email: 'plain@example.test' });
    const response = await schedule(owner, id, body(23));
    assert.equal(response.status, 400, response.text);
    assert.equal(response.body.code, 'not_a_booking_request');
    assert.equal((await inquiryRow(id)).Status, 'New');
    assert.equal(await customersWith('plain@example.test'), 0);
  });

  it('a user with no location is refused and the new customer is rolled back', async () => {
    const id = await addInquiry({ email: 'noloc@example.test' });
    const before0 = await inquiryRow(id);
    const response = await schedule(noLocation, id, body(24));
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.code, 'location_forbidden');
    assert.deepEqual(await inquiryRow(id), before0);
    assert.equal(await customersWith('noloc@example.test'), 0);
  });

  let scheduledId; let scheduledInterval; let scheduledCustomerId;
  it('a user limited to one location cannot schedule at another; at their own location it works', async () => {
    const id = await addInquiry({ email: 'limited@example.test' });
    const before0 = await inquiryRow(id);
    const appointmentsBefore = await appointments();
    const refused = await schedule(limited, id, body(26, { locationId: locationTwo }));
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.body.code, 'location_forbidden');
    assert.deepEqual(await inquiryRow(id), before0);
    assert.equal(await customersWith('limited@example.test'), 0, 'the new customer is rolled back');
    assert.equal(await appointments(), appointmentsBefore);
    assert.equal(await auditCount('inquiry.scheduled', id), 0);
    const allowed = await schedule(limited, id, body(27));
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal(allowed.body.appointment.locationId, locationId);
    assert.equal(await auditCount('inquiry.scheduled', id), 1);
  });

  it('schedules in one transaction: customer, appointment, link and audit rows', async () => {
    scheduledId = await addInquiry({ email: 'Jane.Booking@Example.test' });
    scheduledInterval = interval(5);
    const response = await schedule(owner, scheduledId, { type: 'Consultation', locationId, assignedMembershipId: ownerMembership, ...scheduledInterval });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.inquiry.status, 'Converted');
    assert.equal(response.body.inquiry.appointmentId, response.body.appointment.id);
    assert.equal(response.body.inquiry.convertedOrderId, null);
    assert.equal(response.body.appointment.type, 'Consultation');
    assert.equal(response.body.appointment.status, 'Scheduled');
    assert.match(response.body.appointment.notes, /^Website request: /);
    const row = await inquiryRow(scheduledId);
    assert.equal(row.Status, 'Converted');
    assert.equal(row.AppointmentId, response.body.appointment.id);
    scheduledCustomerId = response.body.appointment.customerId;
    assert.equal(await customersWith('jane.booking@example.test'), 1);
    assert.equal(await auditCount('inquiry.scheduled', scheduledId), 1);
    assert.equal(await auditCount('appointment.created', response.body.appointment.id), 1);
    assert.equal(await auditCount('customer.created', scheduledCustomerId), 1);
  });

  it('a second attempt is 409 inquiry_already_scheduled and creates nothing', async () => {
    const appointmentsBefore = await appointments();
    const before0 = await inquiryRow(scheduledId);
    const response = await schedule(owner, scheduledId, body(30));
    assert.equal(response.status, 409, response.text);
    assert.equal(response.body.code, 'inquiry_already_scheduled');
    assert.equal(await appointments(), appointmentsBefore);
    assert.deepEqual(await inquiryRow(scheduledId), before0);
  });

  it('a clash with the staff member leaves no customer, link or audit row behind', async () => {
    const id = await addInquiry({ email: 'clash@example.test' });
    const before0 = await inquiryRow(id);
    const appointmentsBefore = await appointments();
    const response = await schedule(owner, id, { type: 'Fitting', locationId, assignedMembershipId: ownerMembership, ...scheduledInterval });
    assert.equal(response.status, 409, response.text);
    assert.equal(response.body.code, 'appointment_conflict');
    assert.ok(response.body.conflicts.some((conflict) => conflict.conflictOn.includes('staff')));
    assert.deepEqual(await inquiryRow(id), before0);
    assert.equal(await customersWith('clash@example.test'), 0);
    assert.equal(await auditCount('inquiry.scheduled', id), 0);
    assert.equal(await appointments(), appointmentsBefore);
  });

  it('an existing customer with the same email is reused, not duplicated', async () => {
    const id = await addInquiry({ email: 'jane.booking@example.test' });
    const response = await schedule(owner, id, body(40));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.appointment.customerId, scheduledCustomerId);
    assert.equal(await customersWith('jane.booking@example.test'), 1);
  });

  it('a rejected request cannot be scheduled', async () => {
    const id = await addInquiry({ email: 'rejected@example.test' });
    await db.pool.query(`UPDATE "Inquiries" SET "Status" = 'Rejected' WHERE "Id" = $1`, [id]);
    const response = await schedule(owner, id, body(41));
    assert.equal(response.status, 409, response.text);
    assert.equal(response.body.code, 'not_schedulable');
    assert.equal(await customersWith('rejected@example.test'), 0);
  });

  it('the link cannot point at another business\'s appointment (composite key)', async () => {
    const foreignCustomer = randomUUID();
    const foreignAppointment = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","FullName","Status","CreatedAtUtc") VALUES ($1,$2,'Other customer','Active',now())`, [foreignCustomer, other.businessId]);
    const otherLocation = await firstLocationId(db, other.businessId);
    await db.pool.query(`INSERT INTO "Appointments" ("Id","BusinessId","Type","CustomerId","LocationId","StartUtc","EndUtc","TimeZoneId","Status","CreatedAtUtc")
      VALUES ($1,$2,'Fitting',$3,$4, now() + interval '90 days', now() + interval '90 days 30 minutes','UTC','Scheduled',now())`, [foreignAppointment, other.businessId, foreignCustomer, otherLocation]);
    const id = await addInquiry({ email: 'fk@example.test' });
    await assert.rejects(db.pool.query(`UPDATE "Inquiries" SET "AppointmentId" = $2 WHERE "Id" = $1`, [id, foreignAppointment]), /FK_Inquiries_Appointments_AppointmentId_BusinessId/);
  });
});
