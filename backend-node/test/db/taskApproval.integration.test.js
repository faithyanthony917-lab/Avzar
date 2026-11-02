// Step 18b: task approval, over HTTP on real PostgreSQL, through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: a task of a stage that needs approval goes to AwaitingApproval when the worker completes it and holds back its dependents
// and the order; a stage without the flag completes as before; a manager approves (task completes, dependents become eligible) or
// rejects with a note (task is Paused with the note visible to the worker, who can resume and resubmit); the assignee cannot decide
// their own task; a user without tasks.manage, another business and a location-limited manager's other location are refused; a repeat
// decision is 409; a workflow that makes an optional stage depend on an approval stage is refused.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, firstLocationId, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('task approval on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let worker; let selfManager; let limited; let plainManager;
  let mainLocation; let branchLocation; let otherLocation;
  let workerMember; let selfMember;

  const override = (businessId, key, value) => db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
    VALUES ($1,$2,now(),$3,'test fixture',$4)`, [randomUUID(), businessId, key, value]);
  const membershipOf = async (who) => (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE u."Email" = $1 AND m."BusinessId" = $2`, [who.email, who.businessId])).rows[0].Id;
  const insertOrder = async (businessId, locationId) => {
    const customerId = randomUUID(); const orderId = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Approval customer','Active')`, [customerId, businessId]);
    await db.pool.query(`INSERT INTO "Orders" ("Id","BusinessId","CreatedAtUtc","CurrencyCode","CustomerId","DeliveryMethod","Discount","LocationId","OrderNumber","Priority","PromisedDate","Status","Subtotal","Total")
      VALUES ($1,$2,now(),'NGN',$3,'Collection',0,$4,$5,'Normal',current_date,'InProduction',1000,1000)`, [orderId, businessId, customerId, locationId, `APR-${orderId.replaceAll('-', '').slice(0, 20)}`]);
    return orderId;
  };
  const insertStage = async (businessId, requiresApproval, order) => {
    const workflowId = randomUUID(); const stageId = randomUUID();
    await db.pool.query(`INSERT INTO "Workflows" ("Id","BusinessId","CreatedAtUtc","IsActive","IsDefault","Name") VALUES ($1,$2,now(),TRUE,FALSE,$3)`, [workflowId, businessId, `Flow ${workflowId.slice(0, 8)}`]);
    await db.pool.query(`INSERT INTO "Stages" ("Id","BusinessId","CreatedAtUtc","IsConditional","Key","Name","SortOrder","WorkflowId","RequiresApproval")
      VALUES ($1,$2,now(),FALSE,$3,$4,$5,$6,$7)`, [stageId, businessId, `stage_${order}`, `Stage ${order}`, order, workflowId, requiresApproval]);
    return stageId;
  };
  // One garment and one task per call; a second call with the same garment would need its own garment, so each task gets one.
  const insertTask = async (businessId, orderId, membershipId, { stageId = null, status = 'InProgress', stageOrder = 1, title = 'Approval task' } = {}) => {
    const garmentId = randomUUID(); const taskId = randomUUID();
    await db.pool.query(`INSERT INTO "OrderGarments" ("Id","BusinessId","CreatedAtUtc","LineNumber","LineTotal","Name","OrderId","Quantity","UnitPrice") VALUES ($1,$2,now(),1,1000,'Approval garment',$3,1,1000)`, [garmentId, businessId, orderId]);
    await db.pool.query(`INSERT INTO "ProductionTasks" ("Id","BusinessId","CreatedAtUtc","IsConditional","OrderGarmentId","OrderId","Priority","Quantity","RequiredMaterialsJson","StageName","StageOrder","Status","Title","AssignedMembershipId","StageId","ActualStartUtc")
      VALUES ($1,$2,now(),FALSE,$3,$4,'Normal',1,'[]'::jsonb,'Stage',$5,$6,$7,$8,$9,now())`, [taskId, businessId, garmentId, orderId, stageOrder, status, title, membershipId, stageId]);
    return taskId;
  };
  const dependOn = (businessId, taskId, dependsOnTaskId) => db.pool.query(`INSERT INTO "TaskDependencies" ("TaskId","DependsOnTaskId","BusinessId") VALUES ($1,$2,$3)`, [taskId, dependsOnTaskId, businessId]);
  const statusOf = async (taskId) => (await db.pool.query(`SELECT "Status", "CompletedAtUtc", "ApprovalNote" FROM "ProductionTasks" WHERE "Id" = $1`, [taskId])).rows[0];
  const complete = (who, taskId) => api.call('POST', `/api/my/tasks/${taskId}/complete`, { token: who.token, body: {} });
  const decide = (who, taskId, verb, body = {}) => api.call('POST', `/api/tasks/${taskId}/${verb}`, { token: who.token, body });

  before(async () => {
    db = await createTempDatabase(url, 'avzar_approval');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'ap-owner');
    other = await signUp(api, 'ap-other');
    for (const who of [owner, other]) await upgradePlan(db, who.businessId, 'starter');
    await override(owner.businessId, 'users.max', 'unlimited');
    worker = await addStaff(api, db, owner, 'ap-worker', ['tasks.work']);
    selfManager = await addStaff(api, db, owner, 'ap-self', ['tasks.work', 'tasks.view', 'tasks.manage', 'locations.all']);
    limited = await addStaff(api, db, owner, 'ap-limited', ['tasks.view', 'tasks.manage']);
    plainManager = await addStaff(api, db, owner, 'ap-viewer', ['tasks.view', 'locations.all']);
    workerMember = await membershipOf(worker);
    selfMember = await membershipOf(selfManager);
    mainLocation = await firstLocationId(db, owner.businessId);
    branchLocation = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Branch',TRUE,now())`, [branchLocation, owner.businessId]);
    await db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`, [await membershipOf(limited), mainLocation, owner.businessId]);
    otherLocation = await firstLocationId(db, other.businessId);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('holds a task that needs approval, with its dependent, until a manager approves', async () => {
    const order = await insertOrder(owner.businessId, mainLocation);
    const approvalStage = await insertStage(owner.businessId, true, 1);
    const first = await insertTask(owner.businessId, order, workerMember, { stageId: approvalStage });
    const next = await insertTask(owner.businessId, order, workerMember, { status: 'Pending', stageOrder: 2, title: 'Next step' });
    await dependOn(owner.businessId, next, first);

    const submitted = await complete(worker, first);
    assert.equal(submitted.status, 200, submitted.text);
    const held = await statusOf(first);
    assert.equal(held.Status, 'AwaitingApproval');
    assert.equal(held.CompletedAtUtc, null);
    assert.equal((await api.call('GET', `/api/tasks/${next}`, { token: owner.token })).body.task.isEligible, false);
    assert.notEqual((await db.pool.query(`SELECT "Status" FROM "Orders" WHERE "Id" = $1`, [order])).rows[0].Status, 'Ready');

    const approved = await decide(owner, first, 'approve', { note: 'Looks good' });
    assert.equal(approved.status, 200, approved.text);
    const done = await statusOf(first);
    assert.equal(done.Status, 'Completed');
    assert.ok(done.CompletedAtUtc);
    assert.equal((await api.call('GET', `/api/tasks/${next}`, { token: owner.token })).body.task.isEligible, true);
    const audit = await db.pool.query(`SELECT 1 FROM "AuditLogs" WHERE "BusinessId" = $1 AND "EntityId" = $2 AND "Action" = 'task.approved'`, [owner.businessId, first]);
    assert.equal(audit.rowCount, 1);
    assert.equal((await decide(owner, first, 'approve')).status, 409, 'a repeat decision is refused');
  });

  it('completes a task whose stage does not need approval exactly as before', async () => {
    const order = await insertOrder(owner.businessId, mainLocation);
    const plainStage = await insertStage(owner.businessId, false, 1);
    const task = await insertTask(owner.businessId, order, workerMember, { stageId: plainStage });
    const result = await complete(worker, task);
    assert.equal(result.status, 200, result.text);
    assert.equal((await statusOf(task)).Status, 'Completed');
    const none = await insertTask(owner.businessId, await insertOrder(owner.businessId, mainLocation), workerMember);
    assert.equal((await complete(worker, none)).status, 200);
    assert.equal((await statusOf(none)).Status, 'Completed', 'a task with no stage is unaffected');
  });

  it('rejects with a note, shows it to the worker, and lets the worker resume and resubmit', async () => {
    const order = await insertOrder(owner.businessId, mainLocation);
    const stage = await insertStage(owner.businessId, true, 1);
    const task = await insertTask(owner.businessId, order, workerMember, { stageId: stage });
    assert.equal((await complete(worker, task)).status, 200);
    assert.equal((await decide(owner, task, 'reject', {})).status, 400, 'a note is required');
    assert.equal((await decide(owner, task, 'reject', { note: 'ab' })).status, 400, 'a note of 3 characters or more');
    assert.equal((await decide(owner, task, 'reject', { note: 'Hem is uneven' })).status, 200);
    assert.equal((await statusOf(task)).Status, 'Paused');
    const mine = await api.call('GET', `/api/my/tasks/${task}`, { token: worker.token });
    assert.equal(mine.body.approvalNote, 'Hem is uneven');
    assert.equal((await api.call('POST', `/api/my/tasks/${task}/resume`, { token: worker.token, body: {} })).status, 200);
    assert.equal((await complete(worker, task)).status, 200);
    const again = await statusOf(task);
    assert.equal(again.Status, 'AwaitingApproval');
    assert.equal(again.ApprovalNote, null, 'a new submission clears the old rejection note');
  });

  it('does not let the assignee decide their own task, or a user without tasks.manage decide any', async () => {
    const order = await insertOrder(owner.businessId, mainLocation);
    const stage = await insertStage(owner.businessId, true, 1);
    const task = await insertTask(owner.businessId, order, selfMember, { stageId: stage });
    assert.equal((await complete(selfManager, task)).status, 200);
    const own = await decide(selfManager, task, 'approve');
    assert.equal(own.status, 403, own.text);
    assert.equal((await statusOf(task)).Status, 'AwaitingApproval');
    assert.equal((await decide(plainManager, task, 'approve')).status, 403, 'tasks.view alone is not enough');
    assert.equal((await decide(worker, task, 'reject', { note: 'not allowed' })).status, 403);
    assert.equal((await decide(owner, task, 'approve')).status, 200, 'another manager can');
  });

  it('keeps another business and another location out', async () => {
    const stage = await insertStage(owner.businessId, true, 1);
    const mainTask = await insertTask(owner.businessId, await insertOrder(owner.businessId, mainLocation), workerMember, { stageId: stage, status: 'AwaitingApproval' });
    const branchTask = await insertTask(owner.businessId, await insertOrder(owner.businessId, branchLocation), workerMember, { stageId: stage, status: 'AwaitingApproval' });
    assert.equal((await decide(other, mainTask, 'approve')).status, 404, 'another business sees nothing');
    assert.equal((await statusOf(mainTask)).Status, 'AwaitingApproval');
    assert.equal((await decide(limited, branchTask, 'approve')).status, 404, 'a location-limited manager cannot reach another location');
    assert.equal((await statusOf(branchTask)).Status, 'AwaitingApproval');
    assert.equal((await decide(limited, mainTask, 'approve')).status, 200, 'but can decide at the assigned location');
    const foreignOrder = await insertOrder(other.businessId, otherLocation);
    const foreignTask = await insertTask(other.businessId, foreignOrder, null, { status: 'AwaitingApproval' });
    assert.equal((await decide(owner, foreignTask, 'approve')).status, 404);
    assert.equal((await decide(owner, randomUUID(), 'approve')).status, 404);
    assert.equal((await decide(owner, 'not-a-uuid', 'approve')).status, 400);
  });

  it('refuses a workflow whose optional stage depends on an approval stage', async () => {
    const bad = await api.call('POST', '/api/workflows', { token: owner.token, body: {
      name: 'Fitting flow', stages: [
        { key: 'fit', name: 'Fitting', requiresApproval: true },
        { key: 'alter', name: 'Alteration', isConditional: true, dependsOn: ['fit'] },
      ] } });
    assert.equal(bad.status, 400, bad.text);
    const good = await api.call('POST', '/api/workflows', { token: owner.token, body: {
      name: 'Approval flow', stages: [{ key: 'cut', name: 'Cutting', requiresApproval: true }, { key: 'sew', name: 'Sewing' }] } });
    assert.ok([200, 201].includes(good.status), good.text);
    const saved = await db.pool.query(`SELECT s."Key", s."RequiresApproval" FROM "Stages" s JOIN "Workflows" w ON w."Id" = s."WorkflowId" WHERE w."BusinessId" = $1 AND w."Name" = 'Approval flow' ORDER BY s."SortOrder"`, [owner.businessId]);
    assert.deepEqual(saved.rows.map((r) => [r.Key, r.RequiresApproval]), [['cut', true], ['sew', false]]);
  });
});
