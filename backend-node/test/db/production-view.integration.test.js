// Step-12a: the manager production views (overview, workload, calendar, leave conflicts) over HTTP on real PostgreSQL,
// run through a NOSUPERUSER, NOBYPASSRLS role like the staging database. Fixtures and expectations use the superuser pool.
// Checks: authentication and permission, plan gating, business isolation, location isolation, real numbers from real rows.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const PATHS = ['/api/production/overview', '/api/production/workload', '/api/production/calendar', '/api/production/leave-conflicts'];

describe('production views over HTTP on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let noView; let viewerNoLocation; let viewerLocation2;
  let ownerMembershipId; let location1; let location2; let order1; let order2; let shopPlanId; let freePlanId;
  const ids = {};
  const D = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow (business time zone is UTC)
  const TODAY = new Date().toISOString().slice(0, 10);
  const dow = new Date(`${D}T00:00:00Z`).getUTCDay();
  const utc = (date, time) => `${date}T${time}:00.000Z`;
  const get = (path, who) => api.call('GET', path, { token: who.token });
  const setPlan = (businessId, planId) => db.pool.query('UPDATE "Subscriptions" SET "PlanId" = $2 WHERE "BusinessId" = $1', [businessId, planId]);
  const membershipOf = async (email) => (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE m."BusinessId" = $1 AND u."Email" = $2 AND m."Status" = 0`, [owner.businessId, email])).rows[0].Id;
  const pendingTasks = async (orderId) => (await db.pool.query(`SELECT "Id" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Pending' ORDER BY "StageOrder", "Id"`, [owner.businessId, orderId])).rows.map((row) => row.Id);
  const plan = (taskId, { start, end, minutes, deadline = null, status = 'Scheduled' }) => db.pool.query(`
    UPDATE "ProductionTasks" SET "Status" = $2, "AssignedMembershipId" = $3, "EstimatedMinutes" = $4,
      "PlannedStartUtc" = $5, "PlannedEndUtc" = $6, "DeadlineUtc" = $7 WHERE "Id" = $1`,
  [taskId, status, ownerMembershipId, minutes, start, end, deadline]);
  const count = async (extra, values = []) => (await db.pool.query(`
    SELECT count(*)::int AS n FROM "ProductionTasks" t JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Status" NOT IN ('Completed', 'Cancelled') AND o."Status" IN ('Confirmed', 'InProduction') ${extra}`,
  [owner.businessId, ...values])).rows[0].n;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_production_view');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'pv-owner');
    other = await signUp(api, 'pv-other');
    // The Starter plan allows 3 accounts; this suite needs the owner and three staff, so lift only that one limit.
    await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
      VALUES ($1,$2,now(),'users.max','test fixture: more staff than the plan allows','unlimited')`, [randomUUID(), owner.businessId]);
    // addStaff moves the owner to the starter plan, so staff are added first and the plan is chosen afterwards.
    noView = await addStaff(api, db, owner, 'pv-noview', ['customers.view']);
    viewerNoLocation = await addStaff(api, db, owner, 'pv-noloc', ['tasks.view']);
    viewerLocation2 = await addStaff(api, db, owner, 'pv-loc2', ['tasks.view']);
    const plans = await db.pool.query(`SELECT p."Id", p."Code" FROM "Plans" p JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id"
      WHERE pe."Key" = 'scheduling.shop' AND pe."Value" = 'true' ORDER BY p."Code" LIMIT 1`);
    assert.ok(plans.rows.length, 'a seeded plan must include scheduling.shop');
    shopPlanId = plans.rows[0].Id;
    freePlanId = (await db.pool.query(`SELECT "Id" FROM "Plans" WHERE "Code" = 'free'`)).rows[0].Id;

    // Shop open 08:00-17:00 every day (540 minutes), so capacity numbers do not depend on the weekday the suite runs.
    await db.pool.query('DELETE FROM "BusinessHours" WHERE "BusinessId" = $1', [owner.businessId]);
    for (let day = 0; day < 7; day += 1) {
      await db.pool.query(`INSERT INTO "BusinessHours" ("Id","BusinessId","DayOfWeek","IsOpen","OpensAt","ClosesAt","CreatedAtUtc")
        VALUES ($1,$2,$3,TRUE,'08:00','17:00',now())`, [randomUUID(), owner.businessId, day]);
    }

    location1 = await firstLocationId(db, owner.businessId);
    location2 = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Second branch',TRUE,now())`, [location2, owner.businessId]);
    order1 = (await confirmedOrder(api, db, owner, location1, 'pv1')).orderId;
    order2 = (await confirmedOrder(api, db, owner, location2, 'pv2')).orderId;

    ownerMembershipId = await membershipOf(owner.email);
    const viewer2Membership = await membershipOf(viewerLocation2.email);
    for (const membershipId of [viewer2Membership, ownerMembershipId]) {
      await db.pool.query('INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)', [membershipId, location2, owner.businessId]);
    }

    const tasks1 = await pendingTasks(order1);
    const tasks2 = await pendingTasks(order2);
    assert.ok(tasks1.length >= 5, `the generated workflow must have at least five pending tasks, got ${tasks1.length}`);
    assert.ok(tasks2.length >= 1);
    [ids.t1, ids.t2, ids.t3, ids.unplanned, ids.blocked] = tasks1;
    [ids.t4] = tasks2;
    await plan(ids.t1, { start: utc(D, '09:00'), end: utc(D, '10:00'), minutes: 60 });
    await plan(ids.t2, { start: utc(D, '10:00'), end: utc(D, '11:30'), minutes: 90, deadline: utc(D, '10:00') });
    await plan(ids.t3, { start: utc(TODAY, '00:00'), end: utc(TODAY, '00:30'), minutes: 30 });
    await plan(ids.t4, { start: utc(D, '12:00'), end: utc(D, '13:00'), minutes: 60 });
    await db.pool.query(`UPDATE "ProductionTasks" SET "AssignedMembershipId" = $2, "EstimatedMinutes" = 45 WHERE "Id" = $1`, [ids.unplanned, ownerMembershipId]);
    await db.pool.query(`UPDATE "ProductionTasks" SET "Status" = 'Blocked', "StatusBeforeBlock" = 'Pending' WHERE "Id" = $1`, [ids.blocked]);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('needs a sign-in and the tasks.view permission', async () => {
    for (const path of PATHS) {
      assert.equal((await api.call('GET', path)).status, 401, path);
      assert.equal((await get(path, noView)).status, 403, path);
    }
  });

  it('keeps overview and leave conflicts open on a plan without the shop schedule, and refuses workload and calendar', async () => {
    await setPlan(owner.businessId, freePlanId);
    assert.equal((await get(PATHS[0], owner)).status, 200);
    assert.equal((await get(PATHS[3], owner)).status, 200);
    for (const path of [PATHS[1], PATHS[2]]) {
      const response = await get(path, owner);
      assert.equal(response.status, 403, response.text);
      assert.equal(response.body.code, 'feature_not_in_plan');
    }
    await setPlan(owner.businessId, shopPlanId);
    await setPlan(other.businessId, shopPlanId);
  });

  it('overview: counts match the rows, and today lists only what is planned today', async () => {
    const response = await get(PATHS[0], owner);
    assert.equal(response.status, 200, response.text);
    const { attention } = response.body;
    assert.equal(attention.openTasks, await count(''));
    assert.equal(attention.unassigned, await count('AND t."AssignedMembershipId" IS NULL'));
    assert.equal(attention.noEstimate, await count('AND t."EstimatedMinutes" IS NULL'));
    assert.equal(attention.blocked, 1);
    assert.equal(attention.overdue, 0);
    assert.equal(attention.lateAgainstDeadline, 1, 'task two ends after its deadline');
    assert.equal(response.body.scopedToLocations, false);
    const mine = response.body.todayByWorker.find((group) => group.membershipId === ownerMembershipId);
    assert.deepEqual(mine.tasks.map((task) => task.taskId), [ids.t3]);
    assert.equal(mine.tasks[0].startUtc, utc(TODAY, '00:00'));
  });

  it('another business sees none of it, in any view', async () => {
    const overview = await get(PATHS[0], other);
    assert.equal(overview.body.attention.openTasks, 0);
    assert.deepEqual(overview.body.todayByWorker, []);
    const workload = await get(`${PATHS[1]}?from=${D}&days=1`, other);
    assert.equal(workload.status, 200, workload.text);
    assert.deepEqual(workload.body.workers, []);
    assert.deepEqual((await get(`${PATHS[2]}?from=${D}&days=3`, other)).body.slots, []);
    assert.deepEqual((await get(PATHS[3], other)).body.leaves, []);
  });

  it('a staff member with no location sees nothing', async () => {
    const overview = await get(PATHS[0], viewerNoLocation);
    assert.equal(overview.body.attention.openTasks, 0);
    assert.equal(overview.body.scopedToLocations, true);
    assert.deepEqual((await get(`${PATHS[2]}?from=${D}&days=3`, viewerNoLocation)).body.slots, []);
    assert.deepEqual((await get(`${PATHS[1]}?from=${D}&days=1`, viewerNoLocation)).body.workers, []);
  });

  it('workload: planned minutes, capacity and an over-capacity day from real rows', async () => {
    let response = await get(`${PATHS[1]}?from=${D}&days=3`, owner);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.fromDate, D);
    assert.equal(response.body.days.length, 3);
    let mine = response.body.workers.find((worker) => worker.membershipId === ownerMembershipId);
    // No availability rows: capacity is the shop's open minutes (08:00-17:00 = 540). Planned: 60 + 90 + 60 = 210.
    assert.deepEqual([mine.days[0].capacityMinutes, mine.days[0].plannedMinutes, mine.days[0].status], [540, 210, 'ok']);

    await db.pool.query(`INSERT INTO "WorkerAvailability" ("Id","CapacityMinutes","BusinessId","DayOfWeek","IsAvailable","OpensAt","ClosesAt","MembershipId","CreatedAtUtc")
      VALUES ($1,180,$2,$3,TRUE,'08:00','17:00',$4,now())`, [randomUUID(), owner.businessId, dow, ownerMembershipId]);
    response = await get(`${PATHS[1]}?from=${D}&days=3`, owner);
    mine = response.body.workers.find((worker) => worker.membershipId === ownerMembershipId);
    assert.deepEqual([mine.days[0].capacityMinutes, mine.days[0].plannedMinutes, mine.days[0].status], [180, 210, 'over']);
    assert.equal(mine.days[1].reason, 'unavailable');
    assert.equal(mine.overDays, 1);
    assert.deepEqual([mine.unplannedTasks, mine.unplannedMinutes], [1, 45]);
    assert.equal(response.body.forecast.totalCapacityMinutes, 180);
    assert.equal(response.body.forecast.shortfallMinutes, 210 + 45 - 180);
  });

  it('workload: approved leave lowers the capacity of that day', async () => {
    await db.pool.query(`INSERT INTO "WorkerLeaves" ("Id","BusinessId","MembershipId","StartsAtUtc","EndsAtUtc","Reason","Status","CreatedAtUtc")
      VALUES ($1,$2,$3,$4,$5,'Appointment','Approved',now())`, [randomUUID(), owner.businessId, ownerMembershipId, utc(D, '09:00'), utc(D, '10:00')]);
    const response = await get(`${PATHS[1]}?from=${D}&days=1`, owner);
    const mine = response.body.workers.find((worker) => worker.membershipId === ownerMembershipId);
    assert.deepEqual([mine.days[0].capacityMinutes, mine.days[0].leaveMinutes], [120, 60]);
  });

  it('calendar: slots in order with flags, a worker filter, and input checks', async () => {
    const response = await get(`${PATHS[2]}?from=${D}&days=1`, owner);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.slots.map((slot) => slot.taskId), [ids.t1, ids.t2, ids.t4]);
    const [first, second, third] = response.body.slots;
    assert.equal(first.flags.insideLeave, true, 'task one is planned during approved leave');
    assert.equal(second.flags.lateAgainstDeadline, true);
    assert.equal(third.flags.insideLeave, false);
    assert.equal(first.workerName !== null, true);
    assert.equal(response.body.truncated, false);
    const mineOnly = await get(`${PATHS[2]}?from=${D}&days=1&membershipId=${ownerMembershipId}`, owner);
    assert.equal(mineOnly.body.slots.length, 3);
    const nobody = await get(`${PATHS[2]}?from=${D}&days=1&membershipId=${randomUUID()}`, owner);
    assert.deepEqual(nobody.body.slots, []);
    for (const query of ['from=2026-02-30', 'days=99', 'days=0', 'membershipId=nope']) {
      assert.equal((await get(`${PATHS[2]}?${query}`, owner)).status, 400, query);
    }
    assert.equal((await get(`${PATHS[1]}?days=40`, owner)).status, 400);
  });

  it('a location-limited manager sees only their location, in every view', async () => {
    const calendar = await get(`${PATHS[2]}?from=${D}&days=1`, viewerLocation2);
    assert.deepEqual(calendar.body.slots.map((slot) => slot.taskId), [ids.t4]);
    assert.equal(calendar.body.scopedToLocations, true);
    const overview = await get(PATHS[0], viewerLocation2);
    assert.equal(overview.body.attention.openTasks, await count('AND o."Id" = $2', [order2]));
    assert.equal(overview.body.attention.blocked, 0, 'the blocked task belongs to the other location');
    assert.deepEqual(overview.body.todayByWorker, [], 'today\'s planned task belongs to the other location');
    const workload = await get(`${PATHS[1]}?from=${D}&days=1`, viewerLocation2);
    const mine = workload.body.workers.find((worker) => worker.membershipId === ownerMembershipId);
    assert.equal(mine.days[0].plannedMinutes, 60, 'only the second-location task counts, not tasks one and two');
  });

  it('leave conflicts: lists the tasks a leave collides with, and respects business and location', async () => {
    await db.pool.query(`INSERT INTO "WorkerLeaves" ("Id","BusinessId","MembershipId","StartsAtUtc","EndsAtUtc","Reason","Status","CreatedAtUtc")
      VALUES ($1,$2,$3,$4,$5,'Holiday','Pending',now())`, [randomUUID(), owner.businessId, ownerMembershipId,
      `${new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`,
      `${new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`]);
    const response = await get(PATHS[3], owner);
    assert.equal(response.status, 200, response.text);
    const approved = response.body.leaves.find((leave) => leave.status === 'Approved');
    assert.deepEqual(approved.affectedTasks.map((task) => task.taskId), [ids.t1], 'task two only touches the end of the leave');
    assert.equal(approved.affectedTaskCount, 1);
    const pending = response.body.leaves.find((leave) => leave.status === 'Pending');
    assert.equal(pending.affectedTaskCount, 0);
    assert.deepEqual((await get(PATHS[3], other)).body.leaves, []);
    assert.deepEqual((await get(PATHS[3], viewerNoLocation)).body.leaves, []);
    const limited = await get(PATHS[3], viewerLocation2);
    const seen = limited.body.leaves.find((leave) => leave.status === 'Approved');
    assert.equal(seen.affectedTaskCount, 0, 'task one belongs to the other location');
  });
});
