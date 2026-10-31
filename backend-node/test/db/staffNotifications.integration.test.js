// Step 16a: the staff notifications for leave, appointments, an overloaded worker and an overdue installment, on real PostgreSQL,
// through a NOSUPERUSER, NOBYPASSRLS role like the staging database. Fixtures and expectations use the superuser pool.
// Proves: the right people are told (location-scoped, never the person who made the change, never another business), the text holds no
// leave reason, appointment note or customer name, the sweeps repeat without sending a second notice, and a worker's leave day is
// reported as a collision, not as an overload.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { forEachBusiness, sumResults } from '../../src/db/forEachBusiness.js';
import { enqueueStaffSweep } from '../../src/notifications/staffSweeps.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const silent = { error() {}, info() {} };
const NEW_EVENTS = ['leave.requested', 'leave.decided', 'leave.collision', 'schedule.overload', 'appointment.assigned',
  'appointment.changed', 'appointment.cancelled', 'installment.overdue'];

describe('staff notifications on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let worker; let mgrHere; let mgrElsewhere; let mgrNowhere;
  let ownerM; let workerM; let hereM; let elseM; let nowhereM; let location1; let location2; let order; let leaveId; let apptId;
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const utc = (date, time) => `${date}T${time}:00.000Z`;
  const [D1, D3, D4] = [day(1), day(3), day(4)];
  const membershipOf = async (email) => (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE m."BusinessId" = $1 AND u."Email" = $2 AND m."Status" = 0`, [owner.businessId, email])).rows[0].Id;
  const noticesOf = async (eventType, businessId = owner.businessId) => (await db.pool.query(`SELECT "RecipientMembershipId", "Title", "Body",
    "TargetKind", "TargetId", "DeduplicationKey" FROM "Notifications" WHERE "BusinessId" = $1 AND "EventType" = $2 ORDER BY "CreatedAtUtc", "Id"`,
  [businessId, eventType])).rows;
  const recipientsOf = (rows) => rows.map((row) => row.RecipientMembershipId).sort();
  const plan = (taskId, { start, end, minutes }) => db.pool.query(`UPDATE "ProductionTasks" SET "Status" = 'Scheduled', "AssignedMembershipId" = $2,
    "EstimatedMinutes" = $3, "PlannedStartUtc" = $4, "PlannedEndUtc" = $5 WHERE "Id" = $1`, [taskId, workerM, minutes, start, end]);
  const sweep = async () => sumResults(await forEachBusiness(role.pool, (businessId) => enqueueStaffSweep(role.pool, { businessId, log: silent }), { log: silent }));

  before(async () => {
    db = await createTempDatabase(url, 'avzar_staff_notify');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'sn-owner');
    other = await signUp(api, 'sn-other');
    for (const key of ['users.max', 'appointments.monthly.max']) {
      await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
        VALUES ($1,$2,now(),$3,'test fixture','unlimited')`, [randomUUID(), owner.businessId, key]);
    }
    worker = await addStaff(api, db, owner, 'sn-worker', ['tasks.work']);
    mgrHere = await addStaff(api, db, owner, 'sn-here', ['workers.manage']);
    mgrElsewhere = await addStaff(api, db, owner, 'sn-else', ['workers.manage']);
    mgrNowhere = await addStaff(api, db, owner, 'sn-none', ['workers.manage']);

    // Shop open 08:00-17:00 every day (540 minutes), so capacity does not depend on the weekday the suite runs.
    await db.pool.query('DELETE FROM "BusinessHours" WHERE "BusinessId" = $1', [owner.businessId]);
    for (let d = 0; d < 7; d += 1) {
      await db.pool.query(`INSERT INTO "BusinessHours" ("Id","BusinessId","DayOfWeek","IsOpen","OpensAt","ClosesAt","CreatedAtUtc")
        VALUES ($1,$2,$3,TRUE,'08:00','17:00',now())`, [randomUUID(), owner.businessId, d]);
    }
    location1 = await firstLocationId(db, owner.businessId);
    location2 = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Second branch',TRUE,now())`, [location2, owner.businessId]);
    [ownerM, workerM, hereM, elseM, nowhereM] = await Promise.all([owner, worker, mgrHere, mgrElsewhere, mgrNowhere].map((who) => membershipOf(who.email)));
    for (const [membershipId, locationId] of [[workerM, location1], [hereM, location1], [elseM, location2]]) {
      await db.pool.query('INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)', [membershipId, locationId, owner.businessId]);
    }
    order = await confirmedOrder(api, db, owner, location1, 'sn1');
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('a leave request goes to the leave managers at the worker\'s location, and to the owner, but not to managers elsewhere or with no location', async () => {
    const tasks = (await db.pool.query(`SELECT "Id" FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Pending'
      ORDER BY "StageOrder", "Id"`, [owner.businessId, order.orderId])).rows.map((row) => row.Id);
    assert.ok(tasks.length >= 3, `the generated workflow must have at least three pending tasks, got ${tasks.length}`);
    await plan(tasks[0], { start: utc(D3, '10:00'), end: utc(D3, '11:00'), minutes: 60 });
    await plan(tasks[1], { start: utc(D1, '09:00'), end: utc(D1, '17:00'), minutes: 480 });
    await plan(tasks[2], { start: utc(D1, '09:00'), end: utc(D1, '15:00'), minutes: 360 });

    const response = await api.call('POST', '/api/my/leave-requests', { token: worker.token,
      body: { startsAtUtc: utc(D3, '08:00'), endsAtUtc: utc(D3, '17:00'), reason: 'Family event' } });
    assert.equal(response.status, 201, response.text);
    leaveId = response.body.id;

    const requested = await noticesOf('leave.requested');
    assert.deepEqual(recipientsOf(requested), [ownerM, hereM].sort());
    assert.equal(requested[0].TargetKind, 'leave');
    assert.equal(requested[0].TargetId, leaveId);
    assert.match(requested[0].Body, /asked for leave from/);
    const collision = await noticesOf('leave.collision');
    assert.deepEqual(recipientsOf(collision), [ownerM, hereM].sort());
    assert.match(collision[0].Body, /overlaps 1 planned task/);
    const all = JSON.stringify([...requested, ...collision]);
    assert.ok(!all.includes('Family event'), 'the leave reason never reaches a notification');
  });

  it('an approval tells the worker alone, and the collision goes to the managers except the one who decided', async () => {
    const response = await api.call('POST', `/api/workers/${workerM}/schedule/leave-requests/${leaveId}/review`, { token: owner.token, body: { approve: true, note: 'Enjoy' } });
    assert.equal(response.status, 200, response.text);
    const decided = await noticesOf('leave.decided');
    assert.deepEqual(recipientsOf(decided), [workerM]);
    assert.equal(decided[0].Title, 'Leave approved');
    assert.match(decided[0].Body, /Note: Enjoy/);
    const approvedCollision = (await noticesOf('leave.collision')).filter((row) => row.DeduplicationKey.endsWith(':approved'));
    assert.deepEqual(recipientsOf(approvedCollision), [hereM], 'the owner who approved it is not told about their own action');
  });

  it('a refusal tells the worker, and leave that collides with nothing sends no collision notice', async () => {
    const asked = await api.call('POST', '/api/my/leave-requests', { token: worker.token, body: { startsAtUtc: utc(D4, '08:00'), endsAtUtc: utc(D4, '17:00'), reason: 'Errand' } });
    assert.equal(asked.status, 201, asked.text);
    const refused = await api.call('POST', `/api/workers/${workerM}/schedule/leave-requests/${asked.body.id}/review`, { token: owner.token, body: { approve: false, note: 'Busy week' } });
    assert.equal(refused.status, 200, refused.text);
    const decided = (await noticesOf('leave.decided')).filter((row) => row.TargetId === asked.body.id);
    assert.deepEqual(recipientsOf(decided), [workerM]);
    assert.equal(decided[0].Title, 'Leave not approved');
    assert.equal((await noticesOf('leave.collision')).filter((row) => row.TargetId === asked.body.id).length, 0);
  });

  it('an appointment tells the assigned worker when it is booked, moved and cancelled, without the staff note or the cancellation reason', async () => {
    await db.pool.query('UPDATE "Subscriptions" SET "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = $2) WHERE "BusinessId" = $1', [owner.businessId, 'starter']);
    const at = (d, time) => utc(day(d), time);
    const created = await api.call('POST', '/api/appointments', { token: owner.token, body: {
      type: 'Fitting', customerId: order.customerId, locationId: location1, assignedMembershipId: workerM,
      startAt: at(5, '10:00'), endAt: at(5, '10:45'), notes: 'Private staff note' } });
    assert.equal(created.status, 201, created.text);
    apptId = created.body.id;
    const moved = await api.call('POST', `/api/appointments/${apptId}/reschedule`, { token: owner.token, body: { startAt: at(6, '10:00'), endAt: at(6, '10:45') } });
    assert.equal(moved.status, 200, moved.text);
    const cancelled = await api.call('POST', `/api/appointments/${apptId}/cancel`, { token: owner.token, body: { reason: 'Customer called to cancel' } });
    assert.equal(cancelled.status, 200, cancelled.text);

    for (const eventType of ['appointment.assigned', 'appointment.changed', 'appointment.cancelled']) {
      const rows = await noticesOf(eventType);
      assert.deepEqual(recipientsOf(rows), [workerM], eventType);
      assert.equal(rows[0].TargetKind, 'appointment');
      assert.equal(rows[0].TargetId, apptId);
    }
    const everything = JSON.stringify([...await noticesOf('appointment.assigned'), ...await noticesOf('appointment.changed'), ...await noticesOf('appointment.cancelled')]);
    assert.ok(!everything.includes('Private staff note') && !everything.includes('Customer called'));
  });

  it('the overload sweep tells the schedule managers once, and a day lost to leave is not counted as an overload', async () => {
    const shop = (await db.pool.query(`SELECT p."Id" FROM "Plans" p JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id"
      WHERE pe."Key" = 'scheduling.shop' AND pe."Value" = 'true' ORDER BY p."Code" LIMIT 1`)).rows[0];
    assert.ok(shop, 'a seeded plan must include scheduling.shop');
    await db.pool.query('UPDATE "Subscriptions" SET "PlanId" = $2 WHERE "BusinessId" = $1', [owner.businessId, shop.Id]);

    const first = await sweep();
    assert.ok(first.scheduleOverloads >= 1, JSON.stringify(first));
    const rows = await noticesOf('schedule.overload');
    assert.deepEqual(recipientsOf(rows), [ownerM], 'only the owner holds tasks.manage here');
    assert.match(rows[0].Body, new RegExp(`planned beyond capacity on 1 day in the next week, starting ${D1}`));
    assert.ok(rows[0].DeduplicationKey.endsWith(new Date().toISOString().slice(0, 10)), 'one notice per worker per local day');

    await sweep();
    assert.equal((await noticesOf('schedule.overload')).length, rows.length, 'a second pass the same day sends nothing new');
    await upgradePlan(db, owner.businessId, 'free');
    await sweep();
    assert.equal((await noticesOf('schedule.overload')).length, rows.length);
  });

  it('the installment sweep announces the oldest overdue installment once, to the invoice managers at the invoice location', async () => {
    await upgradePlan(db, owner.businessId, 'starter');
    const draft = await api.call('POST', `/api/invoices/from-order/${order.orderId}`, { token: owner.token, body: { mode: 'Full' } });
    assert.equal(draft.status, 201, draft.text);
    assert.equal((await api.call('POST', `/api/invoices/${draft.body.id}/issue`, { token: owner.token })).status, 200);
    const made = await api.call('POST', `/api/invoices/${draft.body.id}/installment-plan`, { token: owner.token, body: { parts: 2, firstDueDate: '2099-01-01', interval: 'monthly' } });
    assert.equal(made.status, 201, made.text);

    assert.equal((await sweep()).installmentsOverdue, 0, 'nothing is overdue yet');
    await db.pool.query(`UPDATE "InvoiceInstallments" SET "DueDate" = ((now() AT TIME ZONE 'UTC')::date - 3)
      WHERE "BusinessId" = $1 AND "Sequence" = 1 AND "PlanId" IN (SELECT "Id" FROM "InvoiceInstallmentPlans" WHERE "InvoiceId" = $2)`, [owner.businessId, draft.body.id]);
    assert.ok((await sweep()).installmentsOverdue >= 1);
    const rows = await noticesOf('installment.overdue');
    assert.deepEqual(recipientsOf(rows), [ownerM]);
    assert.equal(rows[0].TargetKind, 'invoice');
    assert.equal(rows[0].TargetId, draft.body.id);
    assert.match(rows[0].Body, /^Installment 1 of invoice .+ was due on \d{4}-\d{2}-\d{2} and is not paid\.$/);

    await sweep();
    assert.equal((await noticesOf('installment.overdue')).length, rows.length, 'repeated passes do not repeat the notice');
  });

  it('another business is told nothing, and every new notice points only at rows of its own business', async () => {
    for (const eventType of NEW_EVENTS) assert.equal((await noticesOf(eventType, other.businessId)).length, 0, eventType);
    const stray = await db.pool.query(`SELECT count(*)::int AS n FROM "Notifications" n
      WHERE n."BusinessId" = $1 AND n."EventType" = ANY($2::text[]) AND n."RecipientMembershipId" NOT IN (SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1)`,
    [owner.businessId, NEW_EVENTS]);
    assert.equal(stray.rows[0].n, 0);
    assert.ok(nowhereM && elseM, 'the managers with no matching location were created');
    for (const eventType of ['leave.requested', 'leave.collision']) {
      const told = recipientsOf(await noticesOf(eventType));
      assert.ok(!told.includes(elseM) && !told.includes(nowhereM), `${eventType} stays inside the worker's location`);
    }
  });
});
