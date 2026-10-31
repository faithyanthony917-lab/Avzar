import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { registerRealtimeConnectionForTest } from '../src/realtime/events.js';

const env = {
  NODE_ENV: 'test',
  PORT: 8081,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api',
  JWT_AUDIENCE: 'avzar-mobile',
  ACCESS_TOKEN_MINUTES: 10,
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function fakeRealtimeSocket(businessId) {
  const socket = {
    destroyed: false, writableEnded: false, writableLength: 0, writes: [],
    write(chunk) { this.writes.push(Buffer.from(chunk)); },
  };
  registerRealtimeConnectionForTest(businessId, { id: 'test', businessId, socket });
  // Server frames are unmasked text frames; the JSON text is readable inside them.
  return { events: () => socket.writes.map((frame) => frame.toString('utf8')) };
}

function bearerToken(userId = '00000000-0000-4000-8000-000000000001', businessId = '00000000-0000-4000-8000-000000000002', sessionId = '00000000-0000-4000-8000-000000000003') {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId }).token;
}

describe('orders and tasks', () => {
  it('rejects order and task access without the required permissions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        return { rows: [] };
      },
    };

    const orders = await requestApp(createApp(env, pool), '/api/orders', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(orders.status, 403);
    assert.equal(orders.body.code, 'forbidden');

    const tasks = await requestApp(createApp(env, pool), '/api/tasks', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(tasks.status, 403);
    assert.equal(tasks.body.code, 'forbidden');

    const appointments = await requestApp(createApp(env, pool), '/api/appointments', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(appointments.status, 403);
    assert.equal(appointments.body.code, 'forbidden');

    const createAppointment = await requestApp(createApp(env, pool), '/api/appointments', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(createAppointment.status, 403);
    assert.equal(createAppointment.body.code, 'forbidden');
  });

  it('scopes the manager task-photo HTTP listing to the authenticated business and task', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const taskId = '00000000-0000-4000-8000-000000000090';
    const queries = [];
    const pool = {
      query: async (sql, values = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"') && sql.includes('UserId')) return { rows: [{
          Id: '00000000-0000-4000-8000-0000000000a0', BusinessId: businessId,
          UserId: '00000000-0000-4000-8000-000000000001', Status: 0,
          Permissions: ['tasks.view', 'locations.all'], IsOwner: false,
        }] };
        if (sql.includes('FROM "TaskProgressPhotos" tp')) {
          assert.equal(values[0], businessId);
          assert.equal(values[1], taskId);
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const response = await requestApp(createApp(env, pool), `/api/tasks/${taskId}/photos`, {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { items: [] });
    const listing = queries.find((query) => query.sql.includes('FROM "TaskProgressPhotos" tp'));
    assert.ok(listing, 'photo listing query should execute');
    assert.match(listing.sql, /tp\."BusinessId" = \$1 AND tp\."TaskId" = \$2/);
  });

  it('uploads a progress photo for a worker-assigned task', async () => {
    const taskId = '00000000-0000-4000-8000-000000000090';
    const membershipId = '00000000-0000-4000-8000-0000000000a0';
    const mediaId = '00000000-0000-4000-8000-0000000000b0';
    const uploadCalled = { put: false, delete: false };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"') && sql.includes('UserId')) return { rows: [{ Id: membershipId, BusinessId: '00000000-0000-4000-8000-000000000002', UserId: '00000000-0000-4000-8000-000000000001', Status: 0, Permissions: ['tasks.work'] }] };
        if (sql.includes('SELECT 1 FROM "ProductionTasks"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('INSERT INTO "MediaAssets"')) return { rows: [{ Id: mediaId, Purpose: 'TaskProgressPhoto', OriginalFileName: 'progress.png', Width: 800, Height: 600, SizeBytes: 1234, CreatedAtUtc: new Date().toISOString() }] };
        if (sql.includes('INSERT INTO "TaskProgressPhotos"')) return { rows: [{ Id: '00000000-0000-4000-8000-0000000000c0', TaskId: taskId, MediaAssetId: mediaId, UploadedByMembershipId: membershipId, Caption: 'On the rack', UploadedAtUtc: new Date().toISOString() }] };
        if (sql.includes('INSERT INTO "AuditLogs"')) return { rows: [] };
        if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('SELECT (COALESCE')) return { rows: [{ UsedBytes: '0' }] };
        if (sql.includes('COALESCE(override."Value"')) return { rows: [{ Value: '10' }] };
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: '10' }] };
        return { rows: [] };
      },
      connect: async () => ({
        query: async (sql, values) => {
          if (sql.includes('FROM "ProductionTasks"') && sql.includes('FOR UPDATE')) return { rows: [{ '?column?': 1 }] };
          if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
          if (sql.includes('SELECT (COALESCE')) return { rows: [{ UsedBytes: '0' }] };
          if (sql.includes('COALESCE(override."Value"')) return { rows: [{ Value: '10' }] };
          if (sql.includes('INSERT INTO "MediaAssets"')) return { rows: [{ Id: mediaId, Purpose: 'TaskProgressPhoto', OriginalFileName: 'progress.png', Width: 800, Height: 600, SizeBytes: 1234, CreatedAtUtc: new Date().toISOString() }] };
          if (sql.includes('INSERT INTO "TaskProgressPhotos"')) return { rows: [{ Id: '00000000-0000-4000-8000-0000000000c0', TaskId: taskId, MediaAssetId: mediaId, UploadedByMembershipId: membershipId, Caption: 'On the rack', UploadedAtUtc: new Date().toISOString() }] };
          if (sql.includes('INSERT INTO "AuditLogs"')) return { rows: [] };
          return { rows: [] };
        },
        release() {},
      }),
    };
    const storage = {
      put: async () => { uploadCalled.put = true; },
      delete: async () => { uploadCalled.delete = true; },
      openRead: async () => null,
    };

    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'progress.png');
    form.append('caption', 'On the rack');

    const response = await requestApp(createApp(env, pool, { storage }), `/api/my/tasks/${taskId}/photos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}` },
      body: form,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.taskId, taskId);
    assert.equal(response.body.mediaId, mediaId);
    assert.equal(response.body.caption, 'On the rack');
    assert.equal(uploadCalled.put, true);
  });

  it('allows orders, workflows, fittings and tasks to be read and created with the right permissions', async () => {
    const orderId = '00000000-0000-4000-8000-000000000050';
    const customerId = '00000000-0000-4000-8000-000000000010';
    const locationId = '00000000-0000-4000-8000-000000000060';
    let insertedOrder;
    const orderRecord = {
      Id: orderId, OrderNumber: 'ORD-2026-00001', Status: 'Draft', CustomerId: customerId, CustomerName: 'Nia Adebayo',
      LocationId: locationId, PromisedDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      Priority: 'Normal', DeliveryMethod: 'Collection', CurrencyCode: 'NGN', Subtotal: '425.00',
      Discount: '25.00', Total: '400.00', Version: 1, CreatedAtUtc: new Date('2026-01-01T00:00:00.000Z'),
    };
    const domainQuery = async (sql, values) => {
      if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'unlimited' }] };
      if (sql.includes('INSERT INTO "UsageCounters"')) return { rows: [{ Count: '1' }] };
      if (sql.includes('FROM "Locations"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Customers"') && sql.includes('"Status"')) return { rows: [{ Id: customerId, Status: 'Active' }] };
      if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', Today: '2026-01-01' }] };
      if (sql.includes('INSERT INTO "OrderCounters"')) return { rows: [{ LastValue: '1' }] };
      if (sql.includes('INSERT INTO "Orders"')) { insertedOrder = values; return { rows: [] }; }
      if (sql.includes('SELECT o.*, o.xmin::text::bigint AS "Version"')) return { rows: [orderRecord] };
      if (sql.includes('FROM "OrderGarments"')) {
        if (sql.includes('SELECT "Id", "LineNumber"')) return { rows: [{
          Id: '00000000-0000-4000-8000-000000000070', LineNumber: 1, Name: 'Linen shirt', Category: null,
          Quantity: 2, UnitPrice: '212.50', LineTotal: '425.00', Fabric: null, Colour: null,
          StyleInstructions: null, AlterationNotes: null, MeasurementSetId: null, MeasurementRevision: null,
          MeasurementSnapshotJson: null, DesignId: null, DesignNameSnapshot: null,
        }] };
        return { rows: [] };
      }
      if (sql.includes('FROM "ProductionTasks"')) return { rows: [] };
      if (sql.includes('FROM "Orders"') && sql.includes('"IdempotencyKey"')) return { rows: [] };
      if (sql.includes('FROM "Orders"') && sql.includes('count(*)')) return { rows: [{ TotalCount: 0 }] };
      if (sql.includes('FROM "Orders" o JOIN')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['orders.view', 'orders.manage', 'orders.confirm', 'fittings.manage', 'tasks.view', 'tasks.manage', 'tasks.assign', 'tasks.override', 'tasks.work', 'workflows.manage'] }] };
        return domainQuery(sql, values);
      },
      connect: async () => ({ query: domainQuery, release() {} }),
    };

    const orders = await requestApp(createApp(env, pool), '/api/orders', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(orders.status, 200);
    assert.deepEqual(orders.body.items, []);
    assert.equal(orders.body.totalCount, 0);

    const createOrder = await requestApp(createApp(env, pool), '/api/orders', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId, locationId, promisedDate: orderRecord.PromisedDate, priority: 'Normal',
        deliveryMethod: 'Collection', discount: 25,
        garments: [{ name: 'Linen shirt', quantity: 2, unitPrice: 212.5 }],
      }),
    });
    assert.equal(createOrder.status, 201);
    assert.equal(createOrder.body.customerId, customerId);
    assert.equal(createOrder.body.subtotal, 425);
    assert.equal(createOrder.body.discount, 25);
    assert.equal(createOrder.body.total, 400);
    assert.equal(createOrder.body.garments[0].lineTotal, 425);
    assert.equal(insertedOrder[4], 'ORD-2026-00001');

    // C# parses priority and delivery method trimmed and case-insensitively.
    const looseEnums = await requestApp(createApp(env, pool), '/api/orders', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId, locationId, promisedDate: orderRecord.PromisedDate, priority: ' urgent ',
        deliveryMethod: 'collection', discount: 0,
        garments: [{ name: 'Linen shirt', quantity: 1, unitPrice: 100 }],
      }),
    });
    assert.equal(looseEnums.status, 201);
    assert.equal(insertedOrder[5], 'Urgent');
    assert.equal(insertedOrder[7], 'Collection');

    const badEnum = await requestApp(createApp(env, pool), '/api/orders', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId, locationId, promisedDate: orderRecord.PromisedDate, priority: 'Critical',
        garments: [{ name: 'Linen shirt', quantity: 1, unitPrice: 100 }],
      }),
    });
    assert.equal(badEnum.status, 400);

    const workflows = await requestApp(createApp(env, pool), '/api/workflows', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(workflows.status, 200);
    assert.equal(Array.isArray(workflows.body), true);

    const fittings = await requestApp(createApp(env, pool), '/api/fittings', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(fittings.status, 200);
    assert.deepEqual(fittings.body.items, []);
    assert.equal(fittings.body.totalCount, 0);

    const tasks = await requestApp(createApp(env, pool), '/api/tasks', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(tasks.status, 200);
    assert.deepEqual(tasks.body.items, []);
    assert.equal(tasks.body.totalCount, 0);

    const createTask = await requestApp(createApp(env, pool), '/api/orders/00000000-0000-4000-8000-000000000030/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Alter hem' }),
    });
    assert.equal(createTask.status, 404);
    assert.equal(createTask.body.code, 'order_not_found');
  });

  it('generates workflow tasks and dependencies in the order confirmation transaction', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const orderId = '00000000-0000-4000-8000-000000000050';
    const customerId = '00000000-0000-4000-8000-000000000010';
    const garmentId = '00000000-0000-4000-8000-000000000070';
    const workflowId = '00000000-0000-4000-8000-000000000080';
    const stageOneId = '00000000-0000-4000-8000-000000000081';
    const stageTwoId = '00000000-0000-4000-8000-000000000082';
    const orderRecord = {
      Id: orderId, OrderNumber: 'ORD-2026-00001', Status: 'Confirmed', CustomerId: customerId,
      CustomerName: 'Nia Adebayo', LocationId: '00000000-0000-4000-8000-000000000060',
      PromisedDate: '2026-12-31', Priority: 'High', DeliveryMethod: 'Collection', CurrencyCode: 'NGN',
      Subtotal: '425.00', Discount: '0.00', Total: '425.00', Version: 2,
    };
    const tasks = [];
    const taskDependencies = [];
    const query = async (sql, values) => {
      if (sql.includes('FOR UPDATE OF o')) {
        return { rows: [{ Status: 'Quoted', QuotedAtUtc: '2026-01-01T00:00:00.000Z', PromisedDate: '2026-12-31', CustomerId: customerId, CustomerStatus: 'Active', Today: '2026-01-01' }] };
      }
      if (sql.includes('FROM "QuotationEvents"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT o."Status", o."PromisedDate", o."Priority"')) {
        return { rows: [{ Status: 'Confirmed', PromisedDate: '2026-12-31', Priority: 'High', TimeZoneId: 'UTC' }] };
      }
      if (sql.includes('FROM "OrderGarments" g')) {
        return { rows: [{ Id: garmentId, Name: 'Linen shirt', Quantity: 2, Category: null }] };
      }
      if (sql.includes('SELECT DISTINCT "OrderGarmentId"')) return { rows: [] };
      if (sql.includes('FROM "Workflows"')) return { rows: [{ Id: workflowId, Name: 'Standard', IsDefault: true }] };
      if (sql.includes('FROM "Stages"')) {
        return { rows: [
          { Id: stageOneId, WorkflowId: workflowId, Name: 'Cutting', SortOrder: 1, Instructions: null, RequiredSkill: null, DefaultMinutes: 10, IsConditional: false, CompletionChecks: ['Fabric checked'] },
          { Id: stageTwoId, WorkflowId: workflowId, Name: 'Sewing', SortOrder: 2, Instructions: null, RequiredSkill: null, DefaultMinutes: 20, IsConditional: false, CompletionChecks: [] },
        ] };
      }
      if (sql.includes('FROM "StageDependencies"')) return { rows: [{ StageId: stageTwoId, DependsOnStageId: stageOneId }] };
      if (sql.includes("time '23:59'")) return { rows: [{ DeadlineUtc: '2026-12-31T23:59:00.000Z' }] };
      if (sql.includes('INSERT INTO "ProductionTasks"')) { tasks.push(values); return { rows: [] }; }
      if (sql.includes('INSERT INTO "TaskDependencies"')) { taskDependencies.push(values); return { rows: [] }; }
      if (sql.includes('SELECT o.*, o.xmin::text::bigint AS "Version"')) return { rows: [orderRecord] };
      if (sql.includes('SELECT "Id", "LineNumber"')) {
        return { rows: [{
          Id: garmentId, LineNumber: 1, Name: 'Linen shirt', Category: null, Quantity: 2, UnitPrice: '212.50',
          LineTotal: '425.00', Fabric: null, Colour: null, StyleInstructions: null, AlterationNotes: null,
          MeasurementSetId: null, MeasurementRevision: null, MeasurementSnapshotJson: null, DesignId: null, DesignNameSnapshot: null,
        }] };
      }
      if (sql.includes('FROM "ProductionTasks"') && sql.includes('"Status", "DeadlineUtc"')) {
        return { rows: tasks.map((values) => ({ Status: values[15], DeadlineUtc: values[12] })) };
      }
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: businessId, Email: 'owner@example.test',
          FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: true,
          Permissions: ['orders.confirm'],
        }] };
        return query(sql, values);
      },
      connect: async () => ({ query, release() {} }),
    };

    const response = await requestApp(createApp(env, pool), `/api/orders/${orderId}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(response.status, 200);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0][7], 'Cutting - Linen shirt');
    assert.equal(tasks[0][11], 20);
    assert.deepEqual(tasks[0][17], ['Fabric checked']);
    assert.equal(tasks[1][11], 40);
    assert.equal(taskDependencies.length, 1);
    assert.equal(taskDependencies[0][0], tasks[1][0]);
    assert.equal(taskDependencies[0][1], tasks[0][0]);
    assert.equal(response.body.progress.totalTasks, 2);
  });

  it('persists validated workflow stages and reports dependency keys', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const workflows = new Map();
    const stages = new Map();
    const dependencies = [];
    const query = async (sql, values = []) => {
      if (sql.includes('FROM "Businesses"')) return { rows: [{ Id: businessId }] };
      if (sql.includes('FROM "Workflows"') && sql.includes('ORDER BY "Name" FOR UPDATE')) {
        return { rows: [...workflows.values()].map(({ Id, Name, IsDefault, IsActive }) => ({ Id, Name, IsDefault, IsActive })) };
      }
      if (sql.includes('FROM "Workflows"') && sql.includes('$2::boolean OR "IsActive"')) {
        return { rows: [...workflows.values()].map(({ Id }) => ({ Id })) };
      }
      if (sql.includes('INSERT INTO "Workflows"')) {
        const [Id, BusinessId, Name, Description, IsDefault, IsActive, GarmentCategories] = values;
        workflows.set(Id, { Id, BusinessId, Name, Description, IsDefault, IsActive, GarmentCategories });
        return { rows: [] };
      }
      if (sql.includes('FROM "Stages"') && sql.includes('"WorkflowId" = $2')) {
        if (sql.includes('SELECT "Id", "Key"') && !sql.includes('"CompletionChecks"')) {
          return { rows: [...stages.values()].filter((stage) => stage.WorkflowId === values[1]).map(({ Id, Key }) => ({ Id, Key })) };
        }
        return { rows: [...stages.values()].filter((stage) => stage.WorkflowId === values[1]).sort((a, b) => a.SortOrder - b.SortOrder) };
      }
      if (sql.includes('INSERT INTO "Stages"')) {
        const [Id, BusinessId, WorkflowId, Key, Name, SortOrder, Instructions, RequiredSkill, DefaultMinutes, IsConditional, CompletionChecks] = values;
        stages.set(Id, { Id, BusinessId, WorkflowId, Key, Name, SortOrder, Instructions, RequiredSkill, DefaultMinutes, IsConditional, CompletionChecks });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "StageDependencies"')) {
        dependencies.push({ StageId: values[0], DependsOnStageId: values[1], BusinessId: values[2] });
        return { rows: [] };
      }
      if (sql.includes('FROM "StageDependencies" d')) {
        return { rows: dependencies.filter((dependency) => values[1].includes(dependency.StageId))
          .map((dependency) => ({ ...dependency, DependsOnKey: stages.get(dependency.DependsOnStageId)?.Key })) };
      }
      if (sql.includes('FROM "Workflows"') && sql.includes('"Id" = $2')) return { rows: [workflows.get(values[1])].filter(Boolean) };
      if (sql.includes('INSERT INTO "AuditLogs"')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: businessId, Email: 'owner@example.test',
          FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: true,
          Permissions: ['workflows.manage', 'tasks.view'],
        }] };
        return query(sql, values);
      },
      connect: async () => ({ query, release() {} }),
    };
    const app = createApp(env, pool);
    const authorization = `Bearer ${bearerToken()}`;

    const invalid = await requestApp(app, '/api/workflows', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Cycle', stages: [
          { key: 'cutting', name: 'Cutting', dependsOn: ['sewing'] },
          { key: 'sewing', name: 'Sewing', dependsOn: ['cutting'] },
        ],
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_workflow');
    assert.equal(workflows.size, 0);

    const created = await requestApp(app, '/api/workflows', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Standard Tailoring',
        garmentCategories: ['Shirt'],
        stages: [
          { key: 'cutting', name: 'Cutting', completionChecks: ['Fabric checked'] },
          { key: 'sewing', name: 'Sewing', requiredSkill: 'Sewing', defaultMinutes: 20 },
        ],
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.isDefault, true);
    assert.deepEqual(created.body.garmentCategories, ['Shirt']);
    assert.deepEqual(created.body.stages[0].completionChecks, ['Fabric checked']);
    assert.deepEqual(created.body.stages[1].dependsOn, ['cutting']);
    assert.equal(dependencies.length, 1);

    const listed = await requestApp(app, '/api/workflows', { headers: { authorization } });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].id, created.body.id);
  });

  it('lists production tasks with summaries and hides tasks outside the business', async () => {
    const taskId = '00000000-0000-4000-8000-000000000090';
    const hiddenTaskId = '00000000-0000-4000-8000-000000000091';
    const summary = {
      Id: taskId, OrderId: '00000000-0000-4000-8000-000000000050', OrderNumber: 'ORD-2026-00001',
      OrderStatus: 'Confirmed', OrderGarmentId: '00000000-0000-4000-8000-000000000070',
      GarmentName: 'Linen shirt', StageName: 'Cutting', StageOrder: 1, Title: 'Cutting - Linen shirt',
      Quantity: 2, Status: 'Pending', Priority: 'High', DeadlineUtc: '2026-12-31T23:59:00.000Z',
      AssignedMembershipId: null, AssigneeName: null, RequiredSkill: null, EstimatedMinutes: null,
      IsConditional: false, BlockedType: null, BlockedReason: null, Version: '7', UnmetDependencies: '0',
    };
    const query = async (sql, values = []) => {
      if (sql.includes('SELECT count(*)::int AS "TotalCount"')) return { rows: [{ TotalCount: 1 }] };
      if (sql.includes('xmin::text::bigint AS "Version"')) {
        return { rows: values[1] === hiddenTaskId ? [] : [summary] };
      }
      if (sql.includes('SELECT t."Instructions"')) {
        return { rows: [{
          Instructions: 'Cut on the bias', RequiredChecks: ['Fabric checked'], CompletedChecks: [],
          RequiredMaterialsJson: '[]', CompletionNotes: null, PlannedStartUtc: null, PlannedEndUtc: null,
          ActualStartUtc: null, CompletedAtUtc: null, GarmentName: 'Linen shirt', Category: 'Shirt',
          GarmentQuantity: 2, Fabric: 'Linen', Colour: 'Blue', StyleInstructions: null,
          AlterationNotes: null, MeasurementSnapshotJson: null, CustomerName: 'Nia Adebayo',
        }] };
      }
      if (sql.includes('FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite')) return { rows: [] };
      if (sql.includes('FROM "TaskEvents"')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002',
          Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC',
          CurrencyCode: 'NGN', IsOwner: true, Permissions: ['tasks.view'],
        }] };
        return query(sql, values);
      },
    };
    const app = createApp(env, pool);
    const authorization = `Bearer ${bearerToken()}`;
    const listed = await requestApp(app, '/api/tasks?status=Pending&priority=High&eligible=true', {
      headers: { authorization },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items[0].id, taskId);
    assert.equal(listed.body.items[0].isEligible, true);
    assert.equal(listed.body.items[0].needsEstimate, true);
    assert.equal(listed.body.items[0].version, 7);

    const detail = await requestApp(app, `/api/tasks/${taskId}`, { headers: { authorization } });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.task.title, 'Cutting - Linen shirt');
    assert.deepEqual(detail.body.requiredChecks, ['Fabric checked']);
    assert.equal(detail.body.garment.fabric, 'Linen');
    assert.equal(detail.body.customerName, 'Nia Adebayo');

    const hidden = await requestApp(app, `/api/tasks/${hiddenTaskId}`, { headers: { authorization } });
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.code, 'task_not_found');
  });

  it('creates and optimistically updates production tasks with audit and event records', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const orderId = '00000000-0000-4000-8000-000000000050';
    const garmentId = '00000000-0000-4000-8000-000000000070';
    let inserted;
    let summary;
    let staleUpdate = false;
    const eventCalls = [];
    const auditCalls = [];
    const query = async (sql, values = []) => {
      if (sql.includes('FOR UPDATE OF o')) return { rows: [{
        Id: orderId, Status: 'InProduction', PromisedDate: '2026-12-31', Priority: 'Normal',
        LocationId: '00000000-0000-4000-8000-000000000060', TimeZoneId: 'UTC',
      }] };
      if (sql.includes('FROM "OrderGarments"') && sql.includes('"Quantity"')) return { rows: [{ Id: garmentId, Quantity: 3 }] };
      if (sql.includes("time '23:59'")) return { rows: [{ DeadlineUtc: '2026-12-31T23:59:00.000Z' }] };
      if (sql.includes('INSERT INTO "ProductionTasks"')) {
        inserted = values;
        summary = {
          Id: values[0], OrderId: orderId, OrderNumber: 'ORD-2026-00001', OrderStatus: 'InProduction',
          OrderGarmentId: garmentId, GarmentName: 'Linen shirt', StageName: values[4], StageOrder: 1000,
          Title: values[5], Quantity: 3, Status: 'Pending', Priority: values[11], DeadlineUtc: values[10],
          AssignedMembershipId: null, AssigneeName: null, RequiredSkill: values[8], EstimatedMinutes: values[9],
          IsConditional: false, BlockedType: null, BlockedReason: null, Version: '12', UnmetDependencies: '0',
        };
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "TaskDependencies"')) return { rows: [] };
      if (sql.includes('INSERT INTO "TaskEvents"')) { eventCalls.push(values); return { rows: [] }; }
      if (sql.includes('INSERT INTO "AuditLogs"')) { auditCalls.push(values); return { rows: [] }; }
      if (sql.includes('SELECT "Status" FROM "Orders"') && sql.includes('FOR UPDATE')) return { rows: [{ Status: 'InProduction' }] };
      if (sql.includes('SELECT "Status" FROM "ProductionTasks"')) return { rows: [{ Status: 'Pending' }] };
      if (sql.includes('SELECT t."OrderId", t."Status"')) return { rows: [{
        OrderId: orderId, Status: 'Pending', Instructions: null, Priority: 'High',
        DeadlineUtc: '2026-12-31T23:59:00.000Z', EstimatedMinutes: 30,
        RequiredSkill: 'sewing', RequiredMaterialsJson: '[{"name":"Thread","quantity":1,"unit":"spool"}]',
      }] };
      if (sql.includes('UPDATE "ProductionTasks" SET')) {
        if (staleUpdate) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('xmin::text::bigint AS "Version"')) return { rows: summary ? [summary] : [] };
      if (sql.includes('SELECT t."Instructions"')) return { rows: [{
        Instructions: 'Use a reinforced seam', RequiredChecks: ['Check seam'], CompletedChecks: [],
        RequiredMaterialsJson: '[{"name":"Thread","quantity":1,"unit":"spool"}]',
        CompletionNotes: null, PlannedStartUtc: null, PlannedEndUtc: null, ActualStartUtc: null,
        CompletedAtUtc: null, GarmentName: 'Linen shirt', Category: 'Shirt', GarmentQuantity: 3,
        Fabric: 'Linen', Colour: 'Blue', StyleInstructions: null, AlterationNotes: null,
        MeasurementSnapshotJson: null, CustomerName: 'Nia Adebayo',
      }] };
      if (sql.includes('FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite')) return { rows: [] };
      if (sql.includes('FROM "TaskEvents"')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: businessId, Email: 'owner@example.test',
          FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: true,
          Permissions: ['tasks.manage'],
        }] };
        return query(sql, values);
      },
      connect: async () => ({ query, release() {} }),
    };
    const authorization = `Bearer ${bearerToken()}`;
    const create = await requestApp(createApp(env, pool), `/api/orders/${orderId}/tasks`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Reinforce shoulder seam', orderGarmentId: garmentId, priority: 'High',
        estimatedMinutes: 30, requiredSkill: 'Sewing', completionChecks: ['Check seam'],
        requiredMaterials: [{ name: 'Thread', quantity: 1, unit: 'spool' }],
      }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.task.title, 'Reinforce shoulder seam');
    assert.equal(create.body.task.quantity, 3);
    assert.equal(inserted[5], 'Reinforce shoulder seam');
    assert.equal(inserted[7], 3);
    assert.equal(eventCalls.length, 1);
    assert.equal(auditCalls[0][1], 'task.created');

    const update = await requestApp(createApp(env, pool), `/api/tasks/${inserted[0]}`, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 12, priority: 'Urgent', instructions: 'Use a reinforced seam' }),
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.task.id, inserted[0]);
    assert.ok(update.body.task);
    assert.equal(eventCalls.length, 2);
    assert.equal(auditCalls.at(-1)[1], 'task.updated');

    staleUpdate = true;
    const stale = await requestApp(createApp(env, pool), `/api/tasks/${inserted[0]}`, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 12, priority: 'Low' }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale_version');

    // C# parses priority trimmed and case-insensitively, and accepts offset deadlines such as +01:00.
    const lowerPriority = await requestApp(createApp(env, pool), `/api/orders/${orderId}/tasks`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Press collar', priority: ' high ' }),
    });
    assert.equal(lowerPriority.status, 201);
    assert.equal(inserted[11], 'High');

    const offsetDeadline = await requestApp(createApp(env, pool), `/api/orders/${orderId}/tasks`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Press cuffs', deadline: '2026-12-30T10:00:00+01:00' }),
    });
    assert.equal(offsetDeadline.status, 201);
    assert.equal(inserted[10], '2026-12-30T10:00:00+01:00');

    const badPriority = await requestApp(createApp(env, pool), `/api/orders/${orderId}/tasks`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Press hem', priority: 'Critical' }),
    });
    assert.equal(badPriority.status, 400);
  });

  it('checks worker skill and location before assignment unless an authorised reasoned override is used', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const taskId = '00000000-0000-4000-8000-000000000090';
    const memberId = '00000000-0000-4000-8000-000000000040';
    const task = {
      Id: taskId, OrderId: '00000000-0000-4000-8000-000000000050', OrderNumber: 'ORD-2026-00001',
      OrderStatus: 'InProduction', OrderGarmentId: '00000000-0000-4000-8000-000000000070',
      GarmentName: 'Linen shirt', StageName: 'Sewing', StageOrder: 2, Title: 'Sewing - Linen shirt',
      Quantity: 1, Status: 'Pending', Priority: 'Normal', DeadlineUtc: null, AssignedMembershipId: null,
      AssigneeName: null, RequiredSkill: 'sewing', EstimatedMinutes: 30, IsConditional: false,
      BlockedType: null, BlockedReason: null, Version: '3', UnmetDependencies: '0',
    };
    let assignedMembershipId = null;
    let overridePermission = false;
    const queuedEmails = [];
    const query = async (sql, values = []) => {
      if (sql.includes('SELECT "Id" FROM "Memberships" WHERE "UserId" = $1')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000039' }] };
      if (sql.includes('LEFT JOIN "NotificationPreferences"')) return { rows: [{
        Id: memberId, DisplayName: 'Worker', Email: 'worker@example.test', TimeZoneId: 'UTC',
        QuietHoursEnabled: false, InAppEnabled: true, EmailEnabled: true, PushEnabled: false,
      }] };
      if (sql.includes('INSERT INTO "NotificationOutbox"')) return { rows: [{
        Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
        Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
        InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
        EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
        Status: 'Pending', CreatedAtUtc: values[17],
      }], rowCount: 1 };
      if (sql.includes('SELECT t."OrderId", t."Status", t."AssignedMembershipId"')) {
        return { rows: [{ ...task, AssignedMembershipId: assignedMembershipId, LocationId: '00000000-0000-4000-8000-000000000060' }] };
      }
      if (sql.includes('SELECT m."Id", m."DisplayName"')) return { rows: [{ Id: memberId, DisplayName: 'Worker' }] };
      if (sql.includes('FROM "WorkerSkills"')) return { rows: [] };
      if (sql.includes('FROM "MembershipLocations"')) return { rows: [] };
      if (sql.includes('SELECT membership."DisplayName", appUser."Email"')) {
        return { rows: [{ DisplayName: 'Worker', Email: 'worker@example.test' }] };
      }
      if (sql.includes('SELECT 1 FROM "EmailOutbox" WHERE "DeduplicationKey"')) return { rows: [] };
      if (sql.includes('INSERT INTO "EmailOutbox"')) { queuedEmails.push(values); return { rows: [], rowCount: 1 }; }
      if (sql.includes('UPDATE "NotificationOutbox"')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE "ProductionTasks" SET "AssignedMembershipId"')) {
        assignedMembershipId = values[0];
        return { rows: [{ Version: '4' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "TaskEvents"')) return { rows: [] };
      if (sql.includes('INSERT INTO "AuditLogs"')) return { rows: [] };
      if (sql.includes('SELECT "Status" FROM "Orders"') && sql.includes('FOR UPDATE')) return { rows: [{ Status: 'InProduction' }] };
      if (sql.includes('SELECT "Status" FROM "ProductionTasks"')) return { rows: [{ Status: 'Pending' }] };
      if (sql.includes('xmin::text::bigint AS "Version"')) return { rows: [{
        ...task, AssignedMembershipId: assignedMembershipId, AssigneeName: assignedMembershipId ? 'Worker' : null,
      }] };
      if (sql.includes('SELECT t."Instructions"')) return { rows: [{
        Instructions: null, RequiredChecks: [], CompletedChecks: [], RequiredMaterialsJson: '[]',
        CompletionNotes: null, PlannedStartUtc: null, PlannedEndUtc: null, ActualStartUtc: null,
        CompletedAtUtc: null, GarmentName: 'Linen shirt', Category: 'Shirt', GarmentQuantity: 1,
        Fabric: null, Colour: null, StyleInstructions: null, AlterationNotes: null,
        MeasurementSnapshotJson: null, CustomerName: 'Nia Adebayo',
      }] };
      if (sql.includes('FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite')) return { rows: [] };
      if (sql.includes('FROM "TaskEvents"')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"') && sql.includes('"Permissions"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: businessId, Email: 'owner@example.test',
          FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false,
          Permissions: overridePermission
            ? ['tasks.assign', 'tasks.override', 'locations.all'] : ['tasks.assign', 'locations.all'],
        }] };
        return query(sql, values);
      },
      connect: async () => ({ query, release() {} }),
    };
    const authorization = `Bearer ${bearerToken()}`;
    const blocked = await requestApp(createApp(env, pool), `/api/tasks/${taskId}/assign`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ membershipId: memberId }),
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'assignment_not_allowed');
    assert.equal(blocked.body.problems.length, 2);
    assert.equal(queuedEmails.length, 0);

    const noOverridePermission = await requestApp(createApp(env, pool), `/api/tasks/${taskId}/assign`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ membershipId: memberId, override: true, reason: 'Manager approval' }),
    });
    assert.equal(noOverridePermission.status, 403);
    assert.equal(noOverridePermission.body.code, 'override_not_permitted');
    assert.equal(queuedEmails.length, 0);

    overridePermission = true;
    const overridden = await requestApp(createApp(env, pool), `/api/tasks/${taskId}/assign`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ membershipId: memberId, override: true, reason: 'Manager approval' }),
    });
    assert.equal(overridden.status, 200);
    assert.equal(overridden.body.task.assigneeMembershipId, memberId);
    assert.equal(queuedEmails.length, 1);
    assert.equal(queuedEmails[0][1], businessId);
    assert.match(queuedEmails[0][6], /A production task has been assigned to you/);
    assert.doesNotMatch(queuedEmails[0][6], /Sewing - Linen shirt/);
    assert.equal(queuedEmails[0][7], 'worker@example.test');
    assert.match(queuedEmails[0][8], /^task\.assignment:/);
  });

  it('requires a worker task to be assigned, unblocked by dependencies, and the worker to have no active task', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const taskId = '00000000-0000-4000-8000-000000000090';
    const membershipId = '00000000-0000-4000-8000-000000000040';
    let status = 'Pending';
    let orderStatus = 'Confirmed';
    let blocker = true;
    let anotherActiveTask = false;
    const query = async (sql, values = []) => {
      if (sql.includes('SELECT "Id" FROM "Memberships"') && sql.includes('FOR UPDATE')) return { rows: [{ Id: membershipId }] };
      if (sql.includes('SELECT t."Id", t."OrderId", t."Status"')) return { rows: [{
        Id: taskId, OrderId: '00000000-0000-4000-8000-000000000050', Status: status,
        ActualStartUtc: null, OrderStatus: orderStatus,
      }] };
      if (sql.includes('FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite')) {
        return { rows: blocker ? [{ Title: 'Cutting' }] : [] };
      }
      if (sql.includes('SELECT 1 FROM "ProductionTasks"') && sql.includes('"AssignedMembershipId"')) {
        return { rows: anotherActiveTask ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('UPDATE "ProductionTasks" SET "Status" = $1')) {
        status = values[0];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "TaskEvents"')) return { rows: [] };
      if (sql.includes('SELECT "Status" FROM "Orders"') && sql.includes('FOR UPDATE')) return { rows: [{ Status: orderStatus }] };
      if (sql.includes('SELECT "Status" FROM "ProductionTasks"')) {
        return { rows: status === 'Cancelled' ? [] : [{ Status: status }] };
      }
      if (sql.includes('UPDATE "Orders" SET "Status" = \'InProduction\'')) {
        orderStatus = 'InProduction';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('xmin::text::bigint AS "Version"')) return { rows: [{
        Id: taskId, OrderId: '00000000-0000-4000-8000-000000000050', OrderNumber: 'ORD-2026-00001',
        OrderStatus: orderStatus, OrderGarmentId: '00000000-0000-4000-8000-000000000070',
        GarmentName: 'Linen shirt', StageName: 'Sewing', StageOrder: 2, Title: 'Sewing - Linen shirt',
        Quantity: 1, Status: status, Priority: 'Normal', DeadlineUtc: null, AssignedMembershipId: membershipId,
        AssigneeName: 'Worker', RequiredSkill: null, EstimatedMinutes: 30, IsConditional: false,
        BlockedType: null, BlockedReason: null, Version: '4', UnmetDependencies: blocker ? '1' : '0',
      }] };
      if (sql.includes('SELECT t."Instructions"')) return { rows: [{
        Instructions: null, RequiredChecks: [], CompletedChecks: [], RequiredMaterialsJson: '[]',
        CompletionNotes: null, PlannedStartUtc: null, PlannedEndUtc: null,
        ActualStartUtc: null, CompletedAtUtc: null, GarmentName: 'Linen shirt', Category: 'Shirt',
        GarmentQuantity: 1, Fabric: null, Colour: null, StyleInstructions: null, AlterationNotes: null,
        MeasurementSnapshotJson: null, CustomerName: null,
      }] };
      if (sql.includes('FROM "TaskEvents"')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"') && sql.includes('"Permissions"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: businessId,
          Email: 'worker@example.test', FullName: 'Worker', BusinessName: 'Shop',
          TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: ['tasks.work'],
        }] };
        return query(sql, values);
      },
      connect: async () => ({ query, release() {} }),
    };
    const authorization = `Bearer ${bearerToken()}`;
    const start = (app) => requestApp(app, `/api/my/tasks/${taskId}/start`, {
      method: 'POST', headers: { authorization },
    });

    const blocked = await start(createApp(env, pool));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'dependencies_incomplete');

    blocker = false;
    anotherActiveTask = true;
    const active = await start(createApp(env, pool));
    assert.equal(active.status, 409);
    assert.equal(active.body.code, 'task_in_progress');

    const realtime = fakeRealtimeSocket(businessId);
    assert.equal(realtime.events().length, 0, 'rejected starts publish nothing');

    anotherActiveTask = false;
    const started = await start(createApp(env, pool));
    assert.equal(started.status, 200);
    assert.equal(started.body.task.status, 'InProgress');
    assert.equal(realtime.events().length, 1, 'a worker start publishes one task.updated event');
    assert.match(realtime.events()[0], /"target":"task\.updated"/);
    assert.match(realtime.events()[0], new RegExp(`"taskId":"${taskId}","status":"InProgress"`));
    assert.equal(started.body.customerName, null);
    assert.equal(orderStatus, 'InProduction');
  });

  it('enforces completion checks, activates conditional alterations, and blocks tasks on reported issues', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const orderId = '00000000-0000-4000-8000-000000000050';
    const taskId = '00000000-0000-4000-8000-000000000090';
    const alterationTaskId = '00000000-0000-4000-8000-000000000091';
    const membershipId = '00000000-0000-4000-8000-000000000040';
    let taskStatus = 'InProgress';
    let alterationStatus = 'Cancelled';
    let taskBeforeBlock = null;
    let blockedType = null;
    let blockedReason = null;
    const events = [];
    const garmentUpdates = [];
    const queuedEmails = [];
    let managerRecipientQuery = '';
    let nextStepRecipientQuery = '';
    let managerMode = false;
    const query = async (sql, values = []) => {
      if (sql.includes('SELECT "Id" FROM "Memberships"') && sql.includes('"UserId"')) return { rows: [{ Id: membershipId }] };
      if (sql.includes('LEFT JOIN "NotificationPreferences"')) {
        const people = new Map([
          ['00000000-0000-4000-8000-000000000041', { DisplayName: 'Shop Owner', Email: 'owner@example.test' }],
          ['00000000-0000-4000-8000-000000000042', { DisplayName: 'Manager', Email: 'manager@example.test' }],
          [membershipId, { DisplayName: 'Worker', Email: 'worker@example.test' }],
        ]);
        return { rows: (values[1] ?? []).map((id) => ({
          Id: id, ...people.get(id), TimeZoneId: 'UTC', QuietHoursEnabled: false,
          InAppEnabled: true, EmailEnabled: true, PushEnabled: false,
        })) };
      }
      if (sql.includes('INSERT INTO "NotificationOutbox"')) return { rows: [{
        Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
        Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
        InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
        EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
        Status: 'Pending', CreatedAtUtc: values[17],
      }], rowCount: 1 };
      if (sql.includes('INSERT INTO "Notifications"')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE "NotificationOutbox"')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM "ProductionTasks" t') && sql.includes('"RequiredChecks"')) {
        return { rows: [{ Id: taskId, OrderId: orderId, OrderGarmentId: '00000000-0000-4000-8000-000000000070',
          Status: taskStatus, RequiredChecks: ['Check fitting', 'Record changes'] }] };
      }
      if (sql.includes('SELECT "Id", "OrderId", "Status", "Title" FROM "ProductionTasks"')) {
        return { rows: [{ Id: taskId, OrderId: orderId, Status: taskStatus, Title: 'Fitting - Dress' }] };
      }
      if (sql.includes('SELECT conditional."Id"')) return { rows: [{ Id: alterationTaskId }] };
      if (sql.includes('SELECT "Id" FROM "ProductionTasks"') && sql.includes('"CancelReason"')) {
        return { rows: alterationStatus === 'Cancelled' ? [{ Id: alterationTaskId }] : [] };
      }
      if (sql.includes('UPDATE "ProductionTasks" SET "Status" = \'Pending\'')) {
        alterationStatus = 'Pending';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT DISTINCT t."Id", t."Status"')) return { rows: [] };
      if (sql.includes('SELECT task."Id", task."Title", task."AssignedMembershipId"')) {
        nextStepRecipientQuery = sql;
        return { rows: [{ Id: alterationTaskId, Title: 'Alterations - Dress', AssignedMembershipId: membershipId,
          Version: '6', DisplayName: 'Worker', Email: 'worker@example.test' }] };
      }
      if (sql.includes('UPDATE "ProductionTasks" SET "Status" = \'Completed\'')) {
        taskStatus = 'Completed';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT t."OrderId", t."Status", t."StatusBeforeBlock"')) {
        return { rows: [{ OrderId: orderId, Status: taskStatus, StatusBeforeBlock: taskBeforeBlock,
          ActualStartUtc: null, Title: 'Fitting - Dress', BlockedType: blockedType,
          AssignedMembershipId: membershipId, OrderStatus: 'InProduction' }] };
      }
      if (sql.includes('UPDATE "ProductionTasks" SET "Status" = $1, "StatusBeforeBlock"')) {
        taskStatus = values[0];
        return { rows: [{ Version: '7' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE "ProductionTasks" SET "StatusBeforeBlock"')) {
        taskBeforeBlock = values[0] === 'MissingMaterials' ? taskStatus : taskBeforeBlock;
        blockedType = values[0];
        blockedReason = values[1];
        taskStatus = 'Blocked';
        return { rows: [{ Version: '5' }], rowCount: 1 };
      }
      if (sql.includes('SELECT DISTINCT membership."Id"')) {
        managerRecipientQuery = sql;
        return { rows: [
          { Id: '00000000-0000-4000-8000-000000000041', DisplayName: 'Shop Owner', Email: 'owner@example.test' },
          { Id: '00000000-0000-4000-8000-000000000042', DisplayName: 'Manager', Email: 'manager@example.test' },
        ] };
      }
      if (sql.includes('FROM "Memberships" membership') && sql.includes('membership."Id" = $1')) {
        return { rows: [{ DisplayName: 'Worker', Email: 'worker@example.test' }] };
      }
      if (sql.includes('SELECT 1 FROM "EmailOutbox" WHERE "DeduplicationKey"')) return { rows: [] };
      if (sql.includes('INSERT INTO "EmailOutbox"')) { queuedEmails.push(values); return { rows: [], rowCount: 1 }; }
      if (sql.includes('UPDATE "OrderGarments" SET "AlterationNotes"')) {
        garmentUpdates.push(values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "TaskEvents"')) { events.push(values); return { rows: [] }; }
      if (sql.includes('SELECT "Status" FROM "Orders"') && sql.includes('FOR UPDATE')) return { rows: [{ Status: 'InProduction' }] };
      if (sql.includes('SELECT "Status" FROM "ProductionTasks"')) {
        return { rows: [{ Status: taskStatus }, { Status: alterationStatus }] };
      }
      if (sql.includes('xmin::text::bigint AS "Version"')) return { rows: [{
        Id: taskId, OrderId: orderId, OrderNumber: 'ORD-2026-00001', OrderStatus: 'InProduction',
        OrderGarmentId: '00000000-0000-4000-8000-000000000070', GarmentName: 'Dress',
        StageName: 'Fitting', StageOrder: 3, Title: 'Fitting - Dress', Quantity: 1,
        Status: taskStatus, Priority: 'Normal', DeadlineUtc: null, AssignedMembershipId: membershipId,
        AssigneeName: 'Worker', RequiredSkill: null, EstimatedMinutes: 20, IsConditional: false,
        BlockedType: blockedType, BlockedReason: blockedReason, Version: '4', UnmetDependencies: '0',
      }] };
      if (sql.includes('SELECT t."Instructions"')) return { rows: [{
        Instructions: null, RequiredChecks: ['Check fitting', 'Record changes'], CompletedChecks: [],
        RequiredMaterialsJson: '[]', CompletionNotes: null, PlannedStartUtc: null, PlannedEndUtc: null,
        ActualStartUtc: null, CompletedAtUtc: null, GarmentName: 'Dress', Category: 'Dress',
        GarmentQuantity: 1, Fabric: null, Colour: null, StyleInstructions: null, AlterationNotes: null,
        MeasurementSnapshotJson: null, CustomerName: null,
      }] };
      if (sql.includes('FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite')) return { rows: [] };
      if (sql.includes('FROM "TaskEvents"')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"') && sql.includes('"Permissions"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: businessId,
          Email: 'worker@example.test', FullName: 'Worker', BusinessName: 'Shop',
          TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false,
          Permissions: managerMode ? ['tasks.manage', 'locations.all'] : ['tasks.work'],
        }] };
        return query(sql, values);
      },
      connect: async () => ({ query, release() {} }),
    };
    const authorization = `Bearer ${bearerToken()}`;
    const complete = (body) => requestApp(createApp(env, pool), `/api/my/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const missingCheck = await complete({ completedChecks: ['Check fitting'] });
    assert.equal(missingCheck.status, 400);
    assert.equal(missingCheck.body.code, 'checks_incomplete');
    assert.equal(taskStatus, 'InProgress');
    const realtime = fakeRealtimeSocket(businessId);
    assert.equal(realtime.events().length, 0, 'a rejected completion publishes nothing');

    const completed = await complete({
      completedChecks: ['check fitting', 'Record changes'],
      alterationsRequired: true,
      alterationNotes: 'Shorten the sleeves',
    });
    assert.equal(completed.status, 200);
    assert.equal(taskStatus, 'Completed');
    assert.equal(realtime.events().length, 1);
    assert.match(realtime.events()[0], /"status":"Completed"/);
    assert.equal(alterationStatus, 'Pending');
    assert.equal(garmentUpdates.length, 1);
    assert.match(garmentUpdates[0][0], /^\[Alterations \d{4}-\d{2}-\d{2}\] Shorten the sleeves$/);
    assert.equal(events.some((event) => event[3] === 'alterations_requested'), true);
    assert.equal(events.some((event) => event[3] === 'completed'), true);
    const nextStepEmail = queuedEmails.find((email) => email[5] === 'task.next-step-ready');
    assert.ok(nextStepEmail);
    assert.equal(nextStepEmail[1], businessId);
    assert.equal(nextStepEmail[7], 'worker@example.test');
    assert.match(nextStepEmail[6], /Your next production step is ready to start/);
    assert.doesNotMatch(nextStepEmail[6], /Alterations - Dress/);
    assert.match(nextStepEmail[8], /^task\.next-step-ready:/);
    assert.match(nextStepRecipientQuery, /task\."BusinessId" = \$1/);
    assert.match(nextStepRecipientQuery, /membership\."Status" = 0/);

    taskStatus = 'InProgress';
    const issue = await requestApp(createApp(env, pool), `/api/my/tasks/${taskId}/issues`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'MissingMaterials', description: 'No matching lining is available' }),
    });
    assert.equal(issue.status, 200);
    assert.equal(taskStatus, 'Blocked');
    assert.equal(realtime.events().length, 2);
    assert.match(realtime.events()[1], /"status":"Blocked"/);
    assert.equal(taskBeforeBlock, 'InProgress');
    assert.equal(blockedType, 'MissingMaterials');
    assert.equal(blockedReason, 'No matching lining is available');
    assert.equal(events.some((event) => event[3] === 'issue_reported'), true);
    const issueEmails = queuedEmails.filter((email) => email[5] === 'task.issue');
    assert.equal(issueEmails.length, 2);
    assert.ok(issueEmails.every((email) => email[1] === businessId));
    assert.ok(issueEmails.every((email) => /A production task has been blocked/.test(email[6])));
    assert.ok(issueEmails.every((email) => !/Fitting - Dress|No matching lining is available/.test(email[6])));
    assert.deepEqual(issueEmails.map((email) => email[7]).sort(), ['manager@example.test', 'owner@example.test']);
    assert.ok(issueEmails.every((email) => email[8].startsWith('task.issue:')));
    assert.match(managerRecipientQuery, /membership\."BusinessId" = \$1 AND membership\."Status" = 0/);
    assert.match(managerRecipientQuery, /membership\."IsOwner" = TRUE/);
    assert.match(managerRecipientQuery, /rolePermission\."Permission" = 'tasks\.manage'/);

    managerMode = true;
    const unblocked = await requestApp(createApp(env, pool), `/api/tasks/${taskId}/unblock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${authorization.split(' ')[1]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Materials arrived' }),
    });
    assert.equal(unblocked.status, 200);
    assert.equal(taskStatus, 'Paused');
    const unblockedEmail = queuedEmails.find((email) => email[5] === 'task.unblocked');
    assert.ok(unblockedEmail);
    assert.equal(unblockedEmail[1], businessId);
    assert.equal(unblockedEmail[7], 'worker@example.test');
    assert.match(unblockedEmail[6], /A production task has been unblocked/);
    assert.doesNotMatch(unblockedEmail[6], /Fitting - Dress/);
    assert.match(unblockedEmail[8], /^task\.unblocked:/);
  });

  it('lets a manager explicitly activate conditional alteration tasks with an audit trail', async () => {
    const businessId = '00000000-0000-4000-8000-000000000002';
    const garmentId = '00000000-0000-4000-8000-000000000070';
    const taskId = '00000000-0000-4000-8000-000000000091';
    const auditActions = [];
    const query = async (sql, values = []) => {
      if (sql.includes('FROM "OrderGarments" g JOIN "Orders" o') && sql.includes('FOR UPDATE OF g, o')) {
        return { rows: [{ OrderId: '00000000-0000-4000-8000-000000000050', Status: 'Ready', LocationId: '00000000-0000-4000-8000-000000000060' }] };
      }
      if (sql.includes('SELECT "Id" FROM "ProductionTasks"') && sql.includes('"CancelReason"')) return { rows: [{ Id: taskId }] };
      if (sql.includes('UPDATE "ProductionTasks" SET "Status" = \'Pending\'')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO "TaskEvents"')) return { rows: [] };
      if (sql.includes('UPDATE "OrderGarments" SET "AlterationNotes"')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO "AuditLogs"')) { auditActions.push(sql.includes("'garment.alterations_requested'")); return { rows: [] }; }
      if (sql.includes('SELECT "Status" FROM "Orders"') && sql.includes('FOR UPDATE')) return { rows: [{ Status: 'Ready' }] };
      if (sql.includes('SELECT "Status" FROM "ProductionTasks"')) return { rows: [{ Status: 'Pending' }] };
      if (sql.includes('xmin::text::bigint AS "Version"')) return { rows: [{
        Id: taskId, OrderId: '00000000-0000-4000-8000-000000000050', OrderNumber: 'ORD-2026-00001',
        OrderStatus: 'Ready', OrderGarmentId: garmentId, GarmentName: 'Dress',
        StageName: 'Alterations', StageOrder: 4, Title: 'Alterations - Dress', Quantity: 1,
        Status: 'Pending', Priority: 'Normal', DeadlineUtc: null, AssignedMembershipId: null,
        AssigneeName: null, RequiredSkill: 'sewing', EstimatedMinutes: 20, IsConditional: true,
        BlockedType: null, BlockedReason: null, Version: '5', UnmetDependencies: '0',
      }] };
      if (sql.includes('SELECT t."Instructions"')) return { rows: [{
        Instructions: null, RequiredChecks: [], CompletedChecks: [], RequiredMaterialsJson: '[]',
        CompletionNotes: null, PlannedStartUtc: null, PlannedEndUtc: null, ActualStartUtc: null,
        CompletedAtUtc: null, GarmentName: 'Dress', Category: 'Dress', GarmentQuantity: 1,
        Fabric: null, Colour: null, StyleInstructions: null, AlterationNotes: 'Needs adjustment',
        MeasurementSnapshotJson: null, CustomerName: 'Nia Adebayo',
      }] };
      if (sql.includes('FROM "TaskEvents"')) return { rows: [] };
      if (sql.includes('FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite')) return { rows: [] };
      return { rows: [] };
    };
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"') && sql.includes('"Permissions"')) return { rows: [{
          UserId: '00000000-0000-4000-8000-000000000001', BusinessId: businessId,
          Email: 'manager@example.test', FullName: 'Manager', BusinessName: 'Shop',
          TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: true, Permissions: ['tasks.manage'],
        }] };
        return query(sql, values);
      },
      connect: async () => ({ query, release() {} }),
    };
    const response = await requestApp(createApp(env, pool), `/api/order-garments/${garmentId}/request-alterations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Take in the waist' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    assert.equal(response.body[0].task.isConditional, true);
    assert.equal(auditActions[0], true);
  });
});
