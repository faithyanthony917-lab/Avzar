// Step 11b: confirmed-order amendments are exercised over HTTP against PostgreSQL
// using the same NOSUPERUSER/NOBYPASSRLS application role as the tenant-isolation suite.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { confirmedOrder, firstLocationId, signUp, startApp } from './httpHarness.js';
import { createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('confirmed-order amendments under a restricted PostgreSQL role', { skip: !url }, () => {
  let db; let role; let api;
  let A; let B; let orderId; let locationA; let locationB;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_order_amend');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    api = await startApp(role.pool);
    A = await signUp(api, 'amend-a');
    B = await signUp(api, 'amend-b');
    locationA = await firstLocationId(db, A.businessId);
    locationB = await firstLocationId(db, B.businessId);
    ({ orderId } = await confirmedOrder(api, db, A, locationA, 'amend-a'));
  });

  after(async () => {
    await api?.close();
    await role?.close();
    await db?.drop();
  });

  async function amendmentBody(owner, id, overrides = {}) {
    const response = await api.call('GET', `/api/orders/${id}`, { token: owner.token });
    assert.equal(response.status, 200, response.text);
    const order = response.body;
    return {
      version: order.version,
      locationId: order.locationId,
      promisedDate: order.promisedDate,
      priority: order.priority,
      deliveryMethod: order.deliveryMethod,
      deliveryAddress: order.deliveryAddress,
      deliveryInstructions: order.deliveryInstructions,
      notes: order.notes,
      discount: order.discount,
      garments: order.garments.map((g) => ({
        id: g.id, name: g.name, category: g.category, quantity: g.quantity, unitPrice: g.unitPrice,
        fabric: g.fabric, colour: g.colour, styleInstructions: g.styleInstructions,
        alterationNotes: g.alterationNotes, measurementSetId: g.measurementSetId,
        measurementRevision: g.measurementRevision, designId: g.designId,
      })),
      ...overrides,
    };
  }

  it('rejects cross-business access and a foreign-business location without changing the order', async () => {
    const foreignOrder = await api.call('POST', `/api/orders/${orderId}/amend`, {
      token: B.token, body: await amendmentBody(A, orderId),
    });
    assert.equal(foreignOrder.status, 404, foreignOrder.text);

    const before = await api.call('GET', `/api/orders/${orderId}`, { token: A.token });
    const badLocation = await api.call('POST', `/api/orders/${orderId}/amend`, {
      token: A.token, body: await amendmentBody(A, orderId, { locationId: locationB }),
    });
    assert.equal(badLocation.status, 400, badLocation.text);
    assert.equal(badLocation.body.code, 'unknown_location');
    const afterAttempt = await api.call('GET', `/api/orders/${orderId}`, { token: A.token });
    assert.equal(afterAttempt.body.version, before.body.version);
    assert.equal(afterAttempt.body.locationId, locationA);
  });

  it('updates an unstarted confirmed order and invalidates its old schedule slots', async () => {
    const current = await api.call('GET', `/api/orders/${orderId}`, { token: A.token });
    assert.equal(current.status, 200, current.text);
    const nextDate = new Date(`${current.body.promisedDate}T00:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const body = await amendmentBody(A, orderId, {
      promisedDate: nextDate.toISOString().slice(0, 10),
      garments: current.body.garments.map((g) => ({
        id: g.id, name: g.name, category: g.category, quantity: g.quantity + 1, unitPrice: g.unitPrice,
        fabric: g.fabric, colour: g.colour, styleInstructions: g.styleInstructions,
        alterationNotes: g.alterationNotes, measurementSetId: g.measurementSetId,
        measurementRevision: g.measurementRevision, designId: g.designId,
      })),
    });
    const amended = await api.call('POST', `/api/orders/${orderId}/amend`, { token: A.token, body });
    assert.equal(amended.status, 200, amended.text);
    assert.equal(amended.body.order.promisedDate, body.promisedDate);
    assert.equal(amended.body.scheduleReplanRequired, true);
    const tasks = await db.pool.query(`SELECT t."Status", t."PlannedStartUtc", t."PlannedEndUtc", t."Quantity", t."DeadlineUtc"
      FROM "ProductionTasks" t WHERE t."BusinessId" = $1 AND t."OrderId" = $2`, [A.businessId, orderId]);
    assert.ok(tasks.rows.length > 0, 'confirmed order should have production tasks');
    for (const task of tasks.rows) {
      assert.ok(['Pending', 'Cancelled'].includes(task.Status), `unexpected task status ${task.Status}`);
      if (task.Status === 'Pending') {
        assert.equal(task.PlannedStartUtc, null);
        assert.equal(task.PlannedEndUtc, null);
        assert.ok(Number(task.Quantity) > 0);
        assert.ok(new Date(task.DeadlineUtc).getTime() > 0);
      }
    }
  });

  // ---- Step 11b (second patch): amendment preview, category regeneration and the rules both share ----

  // The fields a garment line may carry in an amendment request (the API rejects unknown fields).
  const lineBody = (g, over = {}) => ({
    id: g.id, name: g.name, category: g.category, quantity: g.quantity, unitPrice: g.unitPrice,
    fabric: g.fabric, colour: g.colour, styleInstructions: g.styleInstructions,
    alterationNotes: g.alterationNotes, measurementSetId: g.measurementSetId,
    measurementRevision: g.measurementRevision, designId: g.designId, ...over,
  });
  // Each test gets its own business: confirmedOrder always creates a customer with the same phone number,
  // so a second call in one business would be refused as a possible duplicate.
  async function freshOrder(label) {
    const owner = await signUp(api, label);
    const locationId = await firstLocationId(db, owner.businessId);
    const { orderId } = await confirmedOrder(api, db, owner, locationId, label);
    return { O: owner, id: orderId };
  }

  const nextDay = (day) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };
  const countRows = async (sql, params) => Number((await db.pool.query(sql, params)).rows[0].count);

  it('previews an amendment without saving, auditing or notifying anything', async () => {
    const { O, id } = await freshOrder('amend-preview');
    const before = await api.call('GET', `/api/orders/${id}`, { token: O.token });
    const body = await amendmentBody(O, id, {
      promisedDate: nextDay(before.body.promisedDate),
      garments: before.body.garments.map((g) => lineBody(g, { quantity: g.quantity + 1 })),
    });
    const preview = await api.call('POST', `/api/orders/${id}/amend/preview`, { token: O.token, body });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.preview, true);
    assert.equal(preview.body.impact.total.previous, before.body.total);
    assert.ok(preview.body.impact.total.next > before.body.total);
    assert.equal(preview.body.impact.promisedDate.next, body.promisedDate);
    assert.ok(preview.body.impact.tasks.updated > 0);
    assert.equal(preview.body.impact.scheduleReplanRequired, true);

    const after = await api.call('GET', `/api/orders/${id}`, { token: O.token });
    assert.equal(after.body.version, before.body.version);
    assert.equal(after.body.total, before.body.total);
    assert.equal(after.body.garments[0].quantity, before.body.garments[0].quantity);
    const taskQuantities = await db.pool.query(`SELECT DISTINCT "Quantity" FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2`, [O.businessId, id]);
    assert.deepEqual(taskQuantities.rows.map((r) => r.Quantity), [before.body.garments[0].quantity]);
    assert.equal(await countRows(`SELECT count(*) FROM "AuditLogs" WHERE "BusinessId" = $1 AND "EntityId" = $2 AND "Action" = 'order.amended'`, [O.businessId, id]), 0);
    assert.equal(await countRows(`SELECT count(*) FROM "TaskEvents" e JOIN "ProductionTasks" t ON t."Id" = e."TaskId" WHERE t."OrderId" = $1 AND e."Type" LIKE 'order_amendment%'`, [id]), 0);

    // The real amendment reports the same impact the preview promised.
    const amended = await api.call('POST', `/api/orders/${id}/amend`, { token: O.token, body });
    assert.equal(amended.status, 200, amended.text);
    assert.deepEqual(amended.body.impact, preview.body.impact);
  });

  it('refuses a preview across businesses, with no token and with a bad order ID', async () => {
    const { O, id } = await freshOrder('amend-preview-iso');
    const body = await amendmentBody(O, id);
    const foreign = await api.call('POST', `/api/orders/${id}/amend/preview`, { token: B.token, body });
    assert.equal(foreign.status, 404, foreign.text);
    const anonymous = await api.call('POST', `/api/orders/${id}/amend/preview`, { body });
    assert.equal(anonymous.status, 401, anonymous.text);
    const badId = await api.call('POST', '/api/orders/not-a-uuid/amend/preview', { token: O.token, body });
    assert.equal(badId.status, 400, badId.text);
  });

  it('gives the same refusal from the preview and the amendment for a stale version', async () => {
    const { O, id } = await freshOrder('amend-stale');
    const body = await amendmentBody(O, id);
    body.version += 1;
    for (const path of ['amend/preview', 'amend']) {
      const response = await api.call('POST', `/api/orders/${id}/${path}`, { token: O.token, body });
      assert.equal(response.status, 409, response.text);
      assert.equal(response.body.code, 'stale_version');
    }
  });

  it('gives the same refusal from the preview and the amendment once production has started', async () => {
    const { O, id } = await freshOrder('amend-started');
    const body = await amendmentBody(O, id, { notes: 'after start' });
    await db.pool.query(`UPDATE "ProductionTasks" SET "Status" = 'InProgress', "ActualStartUtc" = now()
      WHERE "Id" = (SELECT "Id" FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Pending' LIMIT 1)`, [O.businessId, id]);
    for (const path of ['amend/preview', 'amend']) {
      const response = await api.call('POST', `/api/orders/${id}/${path}`, { token: O.token, body });
      assert.equal(response.status, 409, response.text);
      assert.equal(response.body.code, 'production_already_started');
    }
  });

  it('blocks a total change while a live invoice exists, in the preview and the amendment, but allows a date change', async () => {
    const { O, id } = await freshOrder('amend-invoice');
    const draft = await api.call('POST', `/api/invoices/from-order/${id}`, { token: O.token, body: { mode: 'Full' } });
    assert.equal(draft.status, 201, draft.text);
    const current = await api.call('GET', `/api/orders/${id}`, { token: O.token });
    const repriced = await amendmentBody(O, id, { garments: current.body.garments.map((g) => lineBody(g, { unitPrice: g.unitPrice + 100 })) });
    for (const path of ['amend/preview', 'amend']) {
      const response = await api.call('POST', `/api/orders/${id}/${path}`, { token: O.token, body: repriced });
      assert.equal(response.status, 409, response.text);
      assert.equal(response.body.code, 'order_has_invoices');
    }
    const redated = await amendmentBody(O, id, { promisedDate: nextDay(current.body.promisedDate) });
    const preview = await api.call('POST', `/api/orders/${id}/amend/preview`, { token: O.token, body: redated });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.impact.total.previous, preview.body.impact.total.next);
  });

  it('generates tasks for an added line, and then refuses to remove a line that has tasks', async () => {
    const { O, id } = await freshOrder('amend-lines');
    const current = await api.call('GET', `/api/orders/${id}`, { token: O.token });
    const withNewLine = await amendmentBody(O, id, {
      garments: [...current.body.garments.map((g) => lineBody(g)), { name: 'Cap', quantity: 1, unitPrice: 5000 }],
    });
    const preview = await api.call('POST', `/api/orders/${id}/amend/preview`, { token: O.token, body: withNewLine });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.impact.garments.added, 1);
    assert.ok(preview.body.impact.tasks.created > 0);
    const amended = await api.call('POST', `/api/orders/${id}/amend`, { token: O.token, body: withNewLine });
    assert.equal(amended.status, 200, amended.text);
    assert.equal(amended.body.tasksCreated, preview.body.impact.tasks.created);
    const cap = amended.body.order.garments.find((g) => g.name === 'Cap');
    assert.ok(cap, 'the new line is saved');
    assert.ok(await countRows(`SELECT count(*) FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderGarmentId" = $2`, [O.businessId, cap.id]) > 0);

    const withoutCap = await amendmentBody(O, id, { garments: current.body.garments.map((g) => lineBody(g)) });
    for (const path of ['amend/preview', 'amend']) {
      const response = await api.call('POST', `/api/orders/${id}/${path}`, { token: O.token, body: withoutCap });
      assert.equal(response.status, 409, response.text);
      assert.equal(response.body.code, 'garment_has_tasks');
    }
  });

  it('cancels and regenerates a line\'s unstarted tasks when its category selects a different workflow', async () => {
    const { O, id } = await freshOrder('amend-category');
    const workflowId = (await db.pool.query(`
      INSERT INTO "Workflows" ("Id", "BusinessId", "Name", "Description", "IsDefault", "IsActive", "GarmentCategories", "CreatedAtUtc")
      VALUES (gen_random_uuid(), $1, 'Kaftan flow', 'test', FALSE, TRUE, ARRAY['Kaftan']::text[], now()) RETURNING "Id"`, [O.businessId])).rows[0].Id;
    for (const [index, name] of ['Cut kaftan', 'Sew kaftan'].entries()) {
      await db.pool.query(`
        INSERT INTO "Stages" ("Id", "BusinessId", "WorkflowId", "Key", "Name", "SortOrder", "DefaultMinutes", "RequiredSkill", "CompletionChecks", "IsConditional", "Instructions", "CreatedAtUtc")
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 30, NULL, '{}'::text[], FALSE, NULL, now())`,
      [O.businessId, workflowId, `kaftan-${index}`, name, index]);
    }
    const liveBefore = await countRows(`SELECT count(*) FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" IN ('Pending', 'Scheduled')`, [O.businessId, id]);
    assert.ok(liveBefore > 0);

    // A rename changes no category, so it keeps every task.
    const current = await api.call('GET', `/api/orders/${id}`, { token: O.token });
    const renamed = await amendmentBody(O, id, { garments: current.body.garments.map((g) => lineBody(g, { name: 'Agbada (renamed)' })) });
    const renamePreview = await api.call('POST', `/api/orders/${id}/amend/preview`, { token: O.token, body: renamed });
    assert.equal(renamePreview.status, 200, renamePreview.text);
    assert.equal(renamePreview.body.impact.tasks.cancelled, 0);
    assert.equal(renamePreview.body.impact.tasks.created, 0);

    const recategorised = await amendmentBody(O, id, { garments: current.body.garments.map((g) => lineBody(g, { category: 'Kaftan' })) });
    const preview = await api.call('POST', `/api/orders/${id}/amend/preview`, { token: O.token, body: recategorised });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.impact.tasks.cancelled, liveBefore);
    assert.equal(preview.body.impact.tasks.created, 2);
    assert.equal(preview.body.impact.garments.categoryChanges[0].action, 'regenerate');
    assert.equal(await countRows(`SELECT count(*) FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Cancelled' AND "CancelReason" LIKE 'Order amended%'`, [O.businessId, id]), 0, 'the preview cancels nothing');

    const amended = await api.call('POST', `/api/orders/${id}/amend`, { token: O.token, body: recategorised });
    assert.equal(amended.status, 200, amended.text);
    assert.deepEqual(amended.body.impact, preview.body.impact);
    assert.equal(await countRows(`SELECT count(*) FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Cancelled' AND "CancelReason" LIKE 'Order amended%'`, [O.businessId, id]), liveBefore);
    const fresh = await db.pool.query(`
      SELECT t."StageName", t."Status" FROM "ProductionTasks" t JOIN "Stages" s ON s."Id" = t."StageId"
      WHERE t."BusinessId" = $1 AND t."OrderId" = $2 AND s."WorkflowId" = $3 ORDER BY t."StageOrder"`, [O.businessId, id, workflowId]);
    assert.deepEqual(fresh.rows.map((r) => [r.StageName, r.Status]), [['Cut kaftan', 'Pending'], ['Sew kaftan', 'Pending']]);
    assert.equal(await countRows(`SELECT count(*) FROM "TaskEvents" e JOIN "ProductionTasks" t ON t."Id" = e."TaskId" WHERE t."OrderId" = $1 AND e."Type" = 'order_amendment_cancelled'`, [id]), liveBefore);
    assert.equal(await countRows(`SELECT count(*) FROM "AuditLogs" WHERE "BusinessId" = $1 AND "EntityId" = $2 AND "Action" = 'order.amended'`, [O.businessId, id]), 1);
  });
});
