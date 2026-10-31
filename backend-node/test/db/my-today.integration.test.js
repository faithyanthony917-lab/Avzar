// Step-12c: GET /api/my/today (the signed-in worker's planned work for today and own leave) over HTTP on real PostgreSQL,
// run through a NOSUPERUSER, NOBYPASSRLS role like the staging database. Fixtures use the superuser pool.
// Checks: authentication and permission, own rows only (a colleague's tasks and leave, another business), status and day
// filters, leave window and statuses, and the exact fields returned. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const PATH = '/api/my/today';

describe('my today over HTTP on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let worker; let worker2; let noWork; let workerMembership; let worker2Membership;
  const ids = {};
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10); // business time zone is UTC
  const TODAY = day(0);
  const utc = (date, time) => `${date}T${time}:00.000Z`;
  const get = (who) => api.call('GET', PATH, { token: who?.token });
  const membershipOf = async (email) => (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE m."BusinessId" = $1 AND u."Email" = $2 AND m."Status" = 0`, [owner.businessId, email])).rows[0].Id;
  const pendingTasks = async (orderId) => (await db.pool.query(`SELECT "Id" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Pending' ORDER BY "StageOrder", "Id"`, [owner.businessId, orderId])).rows.map((row) => row.Id);
  const plan = (taskId, membershipId, { start, end, status = 'Scheduled' }) => db.pool.query(`
    UPDATE "ProductionTasks" SET "Status" = $2, "AssignedMembershipId" = $3, "EstimatedMinutes" = 30, "PlannedStartUtc" = $4, "PlannedEndUtc" = $5
    WHERE "Id" = $1`, [taskId, status, membershipId, start, end]);
  const addLeave = (businessId, membershipId, start, end, status) => db.pool.query(`INSERT INTO "WorkerLeaves"
    ("Id","BusinessId","MembershipId","StartsAtUtc","EndsAtUtc","Reason","Status","CreatedAtUtc") VALUES ($1,$2,$3,$4,$5,'Test leave',$6,now())`,
  [randomUUID(), businessId, membershipId, start, end, status]);

  before(async () => {
    db = await createTempDatabase(url, 'avzar_my_today');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'mt-owner');
    other = await signUp(api, 'mt-other');
    await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
      VALUES ($1,$2,now(),'users.max','test fixture: more staff than the plan allows','unlimited')`, [randomUUID(), owner.businessId]);
    noWork = await addStaff(api, db, owner, 'mt-nowork', ['customers.view']);
    worker = await addStaff(api, db, owner, 'mt-worker', ['tasks.work']);
    worker2 = await addStaff(api, db, owner, 'mt-worker2', ['tasks.work']);
    workerMembership = await membershipOf(worker.email);
    worker2Membership = await membershipOf(worker2.email);

    const location = await firstLocationId(db, owner.businessId);
    const order = (await confirmedOrder(api, db, owner, location, 'mt1')).orderId;
    const tasks = await pendingTasks(order);
    assert.ok(tasks.length >= 5, `the generated workflow must have at least five pending tasks, got ${tasks.length}`);
    [ids.mine1, ids.mineDone, ids.tomorrow, ids.colleague, ids.cancelled] = tasks;
    await plan(ids.mine1, workerMembership, { start: utc(TODAY, '00:00'), end: utc(TODAY, '00:30') });
    await plan(ids.mineDone, workerMembership, { start: utc(TODAY, '01:00'), end: utc(TODAY, '02:00'), status: 'Completed' });
    await plan(ids.tomorrow, workerMembership, { start: utc(day(1), '09:00'), end: utc(day(1), '10:00') });
    await plan(ids.colleague, worker2Membership, { start: utc(TODAY, '00:00'), end: utc(TODAY, '00:30') });
    await plan(ids.cancelled, workerMembership, { start: utc(TODAY, '03:00'), end: utc(TODAY, '04:00'), status: 'Cancelled' });
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('needs a sign-in and the tasks.work permission', async () => {
    assert.equal((await get(undefined)).status, 401);
    assert.equal((await get(noWork)).status, 403);
  });

  it('lists only my tasks planned today, in time order, without cancelled work', async () => {
    const response = await get(worker);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.today, TODAY);
    assert.equal(response.body.timeZoneId, 'UTC');
    assert.deepEqual(response.body.tasks.map((task) => task.taskId), [ids.mine1, ids.mineDone]);
    assert.equal(response.body.tasks[0].startUtc, utc(TODAY, '00:00'));
    assert.equal(response.body.tasks[1].status, 'Completed');
    assert.equal(response.body.tasksTruncated, false);
  });

  it('returns exactly the documented fields and nothing about anyone else', async () => {
    const response = await get(worker);
    assert.deepEqual(Object.keys(response.body).sort(), ['asOfUtc', 'leave', 'onLeaveToday', 'tasks', 'tasksTruncated', 'timeZoneId', 'today']);
    assert.deepEqual(Object.keys(response.body.tasks[0]).sort(), ['deadlineUtc', 'endUtc', 'estimatedMinutes', 'orderId', 'orderNumber', 'priority', 'stageName', 'startUtc', 'status', 'taskId', 'title']);
  });

  it('a colleague sees only their own task', async () => {
    const response = await get(worker2);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.tasks.map((task) => task.taskId), [ids.colleague]);
  });

  it('another business sees nothing, even though the task rows exist', async () => {
    const response = await get(other);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.tasks, []);
    assert.deepEqual(response.body.leave, []);
    assert.equal(response.body.onLeaveToday, false);
  });

  it('shows my own pending and approved leave from today to 14 days ahead, and nobody else\'s', async () => {
    await addLeave(owner.businessId, workerMembership, utc(TODAY, '00:00'), utc(day(1), '00:00'), 'Approved');
    await addLeave(owner.businessId, workerMembership, utc(day(3), '00:00'), utc(day(4), '00:00'), 'Pending');
    await addLeave(owner.businessId, workerMembership, utc(day(2), '00:00'), utc(day(2), '12:00'), 'Rejected');
    await addLeave(owner.businessId, workerMembership, utc(day(20), '00:00'), utc(day(21), '00:00'), 'Approved'); // beyond the window
    await addLeave(owner.businessId, workerMembership, utc(day(-5), '00:00'), utc(day(-4), '00:00'), 'Approved'); // already over
    await addLeave(owner.businessId, worker2Membership, utc(day(5), '00:00'), utc(day(6), '00:00'), 'Approved');
    const mine = await get(worker);
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(mine.body.leave.map((item) => [item.status, item.startsAtUtc]), [['Approved', utc(TODAY, '00:00')], ['Pending', utc(day(3), '00:00')]]);
    assert.deepEqual(Object.keys(mine.body.leave[0]).sort(), ['endsAtUtc', 'leaveId', 'reason', 'startsAtUtc', 'status']);
    assert.equal(mine.body.onLeaveToday, true);
    const colleague = await get(worker2);
    assert.deepEqual(colleague.body.leave.map((item) => item.startsAtUtc), [utc(day(5), '00:00')]);
    assert.equal(colleague.body.onLeaveToday, false);
  });

  it('pending leave alone does not make me "on leave today"', async () => {
    await db.pool.query('DELETE FROM "WorkerLeaves" WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "Status" = \'Approved\' AND "StartsAtUtc" = $3', [owner.businessId, workerMembership, utc(TODAY, '00:00')]);
    await addLeave(owner.businessId, workerMembership, utc(TODAY, '00:00'), utc(day(1), '00:00'), 'Pending');
    const response = await get(worker);
    assert.equal(response.body.onLeaveToday, false);
    assert.ok(response.body.leave.some((item) => item.status === 'Pending' && item.startsAtUtc === utc(TODAY, '00:00')));
  });
});
