// Slice 6: end-to-end flows over HTTP against a real PostgreSQL built ONLY from the Node migrations + plan seed.
// Covers what the SQL-substring mocks cannot see. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/http/app.js';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { enqueueOverdueTaskReminders } from '../../src/email/overdueTaskReminders.js';
import { enqueueDueWorkerSummaryJobs, runWorkerSummaryCycle } from '../../src/notifications/workerSummaryService.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const PASSWORD = 'correct horse battery staple';

function startApp(pool) {
  const env = loadEnv({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars',
    WEB_BASE_URL: 'https://app.example.test', STORAGE_LOCAL_ROOT: path.join(os.tmpdir(), 'avzar-flows-media'),
  });
  const app = createApp(env, pool);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, pathname, { token, body, headers, redirect } = {}) => {
      // Like a browser: unsafe requests without a bearer token must send the double-submit CSRF cookie and header.
      // Bearer requests are exempt by design, so they send neither.
      let csrf = {};
      if (!token && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const issued = await (await fetch(`${base}/api/auth/csrf`)).json();
        csrf = { cookie: `tailoring.csrf=${issued.token}`, 'x-xsrf-token': issued.token };
      }
      const response = await fetch(base + pathname, {
        method,
        redirect,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...csrf, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: json, text, location: response.headers.get('location') };
    };
    resolve({ call, close: () => new Promise((done) => { app.locals.objectStorage.close(); server.close(done); }) });
  }));
}

async function signUp(api, label) {
  const email = `${label}-${Date.now()}@example.test`;
  const registered = await api.call('POST', '/api/auth/register-business', {
    body: { businessName: `${label} Tailors`, ownerName: `${label} Owner`, email, password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
  assert.equal(registered.status, 201, registered.text);
  const login = await api.call('POST', '/api/auth/token', { body: { email, password: PASSWORD, deviceName: 'integration' } });
  assert.equal(login.status, 200, login.text);
  return { email, token: login.body.accessToken, businessId: login.body.user.businessId };
}

describe('end-to-end flows on a database built only from the Node migrations', { skip: !url }, () => {
  let db; let api; let owner; let other; let locationId;
  const ids = {};

  before(async () => {
    db = await createTempDatabase(url, 'avzar_flows');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
    owner = await signUp(api, 'ade');
    locationId = (await db.pool.query('SELECT "Id" FROM "Locations" WHERE "BusinessId" = $1', [owner.businessId])).rows[0].Id;
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('register-business and login work; duplicate email, bad password and missing token are rejected', async () => {
    assert.ok(owner.token && owner.businessId);
    const dup = await api.call('POST', '/api/auth/register-business', {
      body: { businessName: 'Dup Tailors', ownerName: 'Dup Owner', email: owner.email, password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'email_in_use');
    const bad = await api.call('POST', '/api/auth/token', { body: { email: owner.email, password: 'wrong password here' } });
    assert.equal(bad.status, 401);
    const anonymous = await api.call('GET', '/api/designs');
    assert.equal(anonymous.status, 401);
    const invalid = await api.call('POST', '/api/auth/register-business', { body: { businessName: 'x' } });
    assert.equal(invalid.status, 400);
    const free = await db.pool.query(`SELECT p."Code" FROM "Subscriptions" s JOIN "Plans" p ON p."Id" = s."PlanId" WHERE s."BusinessId" = $1`, [owner.businessId]);
    assert.deepEqual(free.rows.map((r) => r.Code), ['free']);
  });

  it('register-business reports plans_not_seeded on a migrated but unseeded database', async () => {
    const bare = await createTempDatabase(url, 'avzar_unseeded');
    const bareApi = await startApp(bare.pool);
    try {
      await migrate(bare.pool, MIGRATIONS_DIR, quiet);
      const response = await bareApi.call('POST', '/api/auth/register-business', {
        body: { businessName: 'No Plans', ownerName: 'No Plans', email: 'noplans@example.test', password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'plans_not_seeded');
    } finally { await bareApi.close(); await bare.drop(); }
  });

  it('lists saved schedule versions only for the authenticated business', async () => {
    const userId = (await db.pool.query('SELECT "Id" FROM "AspNetUsers" WHERE "Email" = $1', [owner.email])).rows[0].Id;
    const versionId = randomUUID();
    const taskId = randomUUID();
    const publishedAtUtc = new Date().toISOString();
    const slots = [{
      taskId, title: 'Schedule history task', orderNumber: 'HISTORY-1', locationId,
      assignedMembershipId: null, startUtc: '2026-11-02T09:00:00.000Z', endUtc: '2026-11-02T10:00:00.000Z',
    }];
    await db.pool.query(`
      INSERT INTO "ShopScheduleVersions" ("Id", "BusinessId", "VersionNumber", "StartUtc", "HorizonDays",
        "TimeZoneId", "TaskCount", "SlotsJson", "PublishedByUserId", "PublishedAtUtc")
      VALUES ($1,$2,1,$3,7,'UTC',1,$4::jsonb,$5,$6)`,
    [versionId, owner.businessId, '2026-11-02T00:00:00Z', JSON.stringify(slots), userId, publishedAtUtc]);

    const history = await api.call('GET', '/api/tasks/schedule/versions', { token: owner.token });
    assert.equal(history.status, 200, history.text);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].versionNumber, 1);
    assert.deepEqual(history.body[0].slots, slots);

    const unrelated = await signUp(api, 'schedule-isolation');
    const hidden = await api.call('GET', '/api/tasks/schedule/versions', { token: unrelated.token });
    assert.equal(hidden.status, 200, hidden.text);
    assert.deepEqual(hidden.body, []);
  });

  it('creates, filters, cancels and reschedules appointments through the fittings compatibility API', async () => {
    const customer = await api.call('POST', '/api/customers', { token: owner.token, body: {
      fullName: 'Appointment flow customer', email: 'appointment-flow@example.test',
    } });
    assert.equal(customer.status, 201, customer.text);
    const membershipId = (await db.pool.query(`SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = (SELECT "Id" FROM "AspNetUsers" WHERE "Email" = $2)`, [owner.businessId, owner.email])).rows[0].Id;
    const start = new Date(Date.now() + 4 * 86_400_000);
    const end = new Date(start.getTime() + 45 * 60_000);
    const created = await api.call('POST', '/api/appointments', { token: owner.token, body: {
      type: 'Fitting', customerId: customer.body.id, locationId, assignedMembershipId: membershipId,
      startAt: start.toISOString(), endAt: end.toISOString(), notes: 'Bring the fabric samples',
    } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.type, 'Fitting');
    assert.equal(created.body.assignedMembershipId, membershipId);
    assert.equal(created.body.timeZoneId, 'UTC');
    const conflict = await api.call('POST', '/api/appointments', { token: owner.token, body: {
      type: 'Delivery', customerId: customer.body.id, locationId, assignedMembershipId: membershipId,
      startAt: start.toISOString(), endAt: end.toISOString(),
    } });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.body.code, 'appointment_conflict');
    assert.equal(conflict.body.conflicts[0].conflictOn.includes('staff'), true);

    const filtered = await api.call('GET', '/api/appointments?type=Fitting&view=upcoming', { token: owner.token });
    assert.equal(filtered.status, 200, filtered.text);
    assert.ok(filtered.body.items.some((item) => item.id === created.body.id));
    const fittings = await api.call('GET', '/api/fittings', { token: owner.token });
    assert.equal(fittings.status, 200, fittings.text);
    assert.ok(fittings.body.items.some((item) => item.id === created.body.id));

    const unrelated = await signUp(api, 'appointment-isolation');
    const hidden = await api.call('GET', '/api/appointments', { token: unrelated.token });
    assert.equal(hidden.status, 200, hidden.text);
    assert.deepEqual(hidden.body.items, []);

    const usageBefore = Number((await db.pool.query(`SELECT "Count" FROM "UsageCounters" WHERE "BusinessId" = $1 AND "Key" = 'appointments.monthly.max' AND "PeriodStartUtc" = date_trunc('month', now())`, [owner.businessId])).rows[0].Count);
    const missingReason = await api.call('POST', `/api/appointments/${created.body.id}/cancel`, { token: owner.token, body: { reason: ' ' } });
    assert.equal(missingReason.status, 400);
    const cancelled = await api.call('POST', `/api/appointments/${created.body.id}/cancel`, { token: owner.token, body: { reason: 'Customer asked to change the fitting date.' } });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.status, 'Cancelled');
    const reopened = await api.call('POST', `/api/appointments/${created.body.id}/status`, { token: owner.token, body: { status: 'Scheduled' } });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(reopened.body.status, 'Scheduled');

    const rescheduledStart = new Date(start.getTime() + 86_400_000);
    const rescheduled = await api.call('POST', `/api/appointments/${created.body.id}/reschedule`, { token: owner.token, body: {
      startAt: rescheduledStart.toISOString(), endAt: new Date(rescheduledStart.getTime() + 45 * 60_000).toISOString(),
    } });
    assert.equal(rescheduled.status, 200, rescheduled.text);
    assert.equal(rescheduled.body.startUtc, rescheduledStart.toISOString());
    const usageAfter = Number((await db.pool.query(`SELECT "Count" FROM "UsageCounters" WHERE "BusinessId" = $1 AND "Key" = 'appointments.monthly.max' AND "PeriodStartUtc" = date_trunc('month', now())`, [owner.businessId])).rows[0].Count);
    assert.equal(usageAfter, usageBefore, 'reopen/reschedule must not consume a second appointment entitlement');
  });

  it('creates, lists and reads designs with the PostgreSQL array fields', async () => {
    const created = await api.call('POST', '/api/designs', { token: owner.token, body: {
      name: 'Agbada Classic', kind: 'MadeToOrder', tags: ['Wedding', 'Formal'], fabrics: ['Aso Oke'], colours: ['Navy'], sizes: ['M', 'L'], basePrice: 45000, productionDays: 14 } });
    assert.equal(created.status, 201, created.text);
    ids.design = created.body.id;
    ids.designSlug = created.body.slug;
    const raw = await db.pool.query('SELECT "Tags","Fabrics","Colours","Sizes" FROM "Designs" WHERE "Id" = $1', [ids.design]);
    assert.deepEqual(raw.rows[0].Fabrics, ['Aso Oke']);
    assert.deepEqual(raw.rows[0].Sizes, ['M', 'L']);
    assert.equal(raw.rows[0].Tags.length, 2);
    const list = await api.call('GET', '/api/designs', { token: owner.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((d) => d.id), [ids.design]);
    const byTag = await api.call('GET', `/api/designs?tag=${encodeURIComponent(raw.rows[0].Tags[0])}`, { token: owner.token });
    assert.equal(byTag.body.totalCount, 1);
    const one = await api.call('GET', `/api/designs/${ids.design}`, { token: owner.token });
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.sizes, ['M', 'L']);
    assert.deepEqual(one.body.colours, ['Navy']);
    const invalid = await api.call('POST', '/api/designs', { token: owner.token, body: { name: 'x' } });
    assert.equal(invalid.status, 400);
  });

  it('publishes a storefront and the public listing and detail return the design with its arrays', async () => {
    const site = await api.call('POST', '/api/storefronts', { token: owner.token, body: { name: 'Ade Tailors', slug: 'ade-tailors' } });
    assert.equal(site.status, 201, site.text);
    const published = await api.call('POST', `/api/storefronts/${site.body.id}/publish`, { token: owner.token, body: {} });
    assert.equal(published.status, 200, published.text);
    const publishedSite = await api.call('GET', `/api/storefronts/${site.body.id}`, { token: owner.token });
    assert.equal(publishedSite.status, 200, publishedSite.text);
    const before = await api.call('GET', '/public/sites/ade-tailors/designs');
    assert.equal(before.status, 200);
    assert.equal(before.body.totalCount, 0, 'private designs must not be public');
    const visible = await api.call('POST', `/api/designs/${ids.design}/visibility`, { token: owner.token, body: { visibility: 'Public' } });
    assert.equal(visible.status, 200, visible.text);
    const listing = await api.call('GET', '/public/sites/ade-tailors/designs');
    assert.deepEqual(listing.body.items.map((d) => d.name), ['Agbada Classic']);
    const detail = await api.call('GET', `/public/sites/ade-tailors/designs/${ids.designSlug}`);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual(detail.body.fabrics, ['Aso Oke']);
    assert.deepEqual(detail.body.sizes, ['M', 'L']);
    assert.equal((await api.call('GET', '/public/sites/nope-nope/designs')).status, 404);

    const renamed = await api.call('PUT', `/api/storefronts/${site.body.id}/slug`, { token: owner.token, body: {
      version: publishedSite.body.version, slug: 'ade-workroom',
    } });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.slug, 'ade-workroom');
    const oldUrl = await api.call('GET', `/public/sites/ade-tailors/designs/${ids.designSlug}?campaign=spring`, { redirect: 'manual' });
    assert.equal(oldUrl.status, 308);
    assert.equal(oldUrl.location, `/public/sites/ade-workroom/designs/${ids.designSlug}?campaign=spring`);
    assert.deepEqual((await api.call('GET', '/public/resolve-slug/ade-tailors')).body, { slug: 'ade-workroom' });

    const renamedAgain = await api.call('PUT', `/api/storefronts/${site.body.id}/slug`, { token: owner.token, body: {
      version: renamed.body.version, slug: 'ade-final',
    } });
    assert.equal(renamedAgain.status, 200, renamedAgain.text);
    assert.equal((await api.call('GET', '/public/resolve-slug/ade-tailors')).body.slug, 'ade-final');
    const redirectedAgain = await api.call('GET', '/public/sites/ade-workroom/designs?campaign=spring', { redirect: 'manual' });
    assert.equal(redirectedAgain.status, 308);
    assert.equal(redirectedAgain.location, '/public/sites/ade-final/designs?campaign=spring');

    const otherBusiness = await signUp(api, 'slug-reservation');
    const aliasTaken = await api.call('POST', '/api/storefronts', { token: otherBusiness.token, body: { name: 'Old Address', slug: 'ade-tailors' } });
    assert.equal(aliasTaken.status, 409);
    assert.equal(aliasTaken.body.code, 'slug_taken');
  });

  it('enforces plan limits and flags from the seeded plans', async () => {
    const second = await api.call('POST', '/api/storefronts', { token: owner.token, body: { name: 'Second Site', slug: 'second-site' } });
    assert.equal(second.status, 403);
    assert.equal(second.body.code, 'plan_limit_reached');
    assert.equal(second.body.entitlement, 'storefront.count.max');
    await db.pool.query(`UPDATE "PlanEntitlements" SET "Value" = '2' WHERE "Key" = 'designs.max' AND "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = 'free')`);
    const d2 = await api.call('POST', '/api/designs', { token: owner.token, body: { name: 'Kaftan Slim' } });
    assert.equal(d2.status, 201, d2.text);
    const d3 = await api.call('POST', '/api/designs', { token: owner.token, body: { name: 'Third Design' } });
    assert.equal(d3.status, 403);
    assert.equal(d3.body.code, 'plan_limit_reached');
    assert.equal(d3.body.limit, 2);
    await db.pool.query(`UPDATE "PlanEntitlements" SET "Value" = '50' WHERE "Key" = 'designs.max' AND "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = 'free')`);
    const ok = await api.call('POST', '/api/designs', { token: owner.token, body: { name: 'Third Design' } });
    assert.equal(ok.status, 201, 'admin edits to the plan take effect');
  });

  it('order -> quote -> confirm generates the production tasks', async () => {
    const customer = await api.call('POST', '/api/customers', { token: owner.token, body: { fullName: 'Tunde Bello', email: 'tunde@example.test', phone: '+2348012345678' } });
    assert.equal(customer.status, 201, customer.text);
    ids.customer = customer.body.id;
    const promised = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const order = await api.call('POST', '/api/orders', { token: owner.token, body: {
      customerId: ids.customer, locationId, promisedDate: promised, garments: [{ name: 'Agbada', quantity: 2, unitPrice: 20000 }] } });
    assert.equal(order.status, 201, order.text);
    ids.order = order.body.id;
    assert.equal(order.body.status, 'Draft');
    assert.deepEqual(order.body.allowedStatusChanges, ['Quoted', 'Cancelled'], 'the order says which moves are open to it');
    assert.equal((await api.call('POST', `/api/orders/${ids.order}/confirm`, { token: owner.token })).status, 409, 'a draft cannot be confirmed');
    assert.equal((await api.call('POST', `/api/orders/${ids.order}/quote`, { token: owner.token })).status, 200);
    // Confirmation now requires the customer to approve the exact quotation version.
    assert.equal((await api.call('POST', `/api/orders/${ids.order}/quotation/send`, { token: owner.token })).status, 200);
    const email = (await db.pool.query(`SELECT "TextBody" FROM "EmailOutbox"
      WHERE "BusinessId" = $1 AND "TemplateKey" = 'quotation_sent' ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [owner.businessId])).rows[0];
    const portalToken = /customer-portal#([A-Za-z0-9_-]+)/.exec(email.TextBody)?.[1];
    assert.ok(portalToken, 'quotation email must contain the customer portal token');
    const portal = await api.call('POST', '/api/customer-portal/quotations', { body: { token: portalToken } });
    const quotation = portal.body.quotations.find((item) => item.orderId === ids.order);
    assert.ok(quotation, 'customer portal must show the quoted order');
    const approved = await api.call('POST', '/api/customer-portal/quotations/respond', {
      body: { token: portalToken, orderId: ids.order, quotationId: quotation.quotationId, decision: 'approve' } });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.decision, 'Approved');
    const confirmed = await api.call('POST', `/api/orders/${ids.order}/confirm`, { token: owner.token });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.body.status, 'Confirmed');
    assert.deepEqual(confirmed.body.allowedStatusChanges, ['InProduction', 'Ready', 'Cancelled']);
    const tasks = await db.pool.query(`SELECT "StageName","Status","IsConditional","RequiredChecks","CompletedChecks" FROM "ProductionTasks" WHERE "OrderId" = $1 ORDER BY "StageOrder"`, [ids.order]);
    assert.equal(tasks.rows.length, 10);
    assert.equal(tasks.rows.filter((t) => t.Status === 'Pending').length, 9);
    assert.equal(tasks.rows.filter((t) => t.IsConditional && t.Status === 'Cancelled').length, 1);
    assert.deepEqual(tasks.rows[0].RequiredChecks, ['Measurements match the order snapshot']);
    assert.deepEqual(tasks.rows[0].CompletedChecks, []);
    const deps = await db.pool.query('SELECT count(*)::int AS n FROM "TaskDependencies" WHERE "BusinessId" = $1', [owner.businessId]);
    assert.equal(deps.rows[0].n, 10);
    const again = await api.call('POST', `/api/orders/${ids.order}/generate-tasks`, { token: owner.token, body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.tasksCreated, 0, 'task generation is idempotent per garment');
  });

  it('queues one overdue reminder per assigned task and UTC day', async () => {
    const task = (await db.pool.query(`SELECT "Id" FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Pending' ORDER BY "Id" LIMIT 1`, [owner.businessId, ids.order])).rows[0];
    const membership = (await db.pool.query(`SELECT membership."Id" FROM "Memberships" membership
      JOIN "AspNetUsers" appUser ON appUser."Id" = membership."UserId"
      WHERE membership."BusinessId" = $1 AND membership."Status" = 0 AND appUser."Email" = $2`, [owner.businessId, owner.email])).rows[0];
    await db.pool.query(`UPDATE "ProductionTasks" SET "DeadlineUtc" = now() - interval '1 day', "AssignedMembershipId" = $1
      WHERE "BusinessId" = $2 AND "Id" = $3`, [membership.Id, owner.businessId, task.Id]);

    assert.equal(await enqueueOverdueTaskReminders(db.pool), 1);
    assert.equal(await enqueueOverdueTaskReminders(db.pool), 0);
    const rows = await db.pool.query(`SELECT "TemplateKey","DeduplicationKey","BusinessId","ToAddress" FROM "EmailOutbox"
      WHERE "TemplateKey" = 'task.overdue' AND "BusinessId" = $1`, [owner.businessId]);
    assert.deepEqual(rows.rows.map((row) => row.TemplateKey), ['task.overdue']);
    assert.match(rows.rows[0].DeduplicationKey, /^task\.overdue:/);
    assert.equal(rows.rows[0].ToAddress.toLowerCase(), owner.email.toLowerCase());
  });

  it('queues task assignment, issue and unblock notifications with real SQL, scoped to this business and deduplicated', async () => {
    // Regression: these statements once aliased AspNetUsers as the reserved word `user`, which PostgreSQL cannot parse.
    // SQL-substring mocks cannot see that, so this runs the real queries.
    const outsider = await signUp(api, 'outsider');
    const worker = await signUp(api, 'worker');
    const workerUserId = (await db.pool.query('SELECT "Id" FROM "AspNetUsers" WHERE "NormalizedEmail" = upper($1)', [worker.email])).rows[0].Id;
    const membershipId = randomUUID();
    const roleId = randomUUID();
    await db.pool.query(`INSERT INTO "Memberships" ("Id","BusinessId","CreatedAtUtc","DisplayName","IsOwner","Status","UserId")
      VALUES ($1,$2,now(),'Notification Worker',FALSE,0,$3)`, [membershipId, owner.businessId, workerUserId]);
    await db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`, [membershipId, locationId, owner.businessId]);
    await db.pool.query(`INSERT INTO "BusinessRoles" ("Id","BusinessId","CreatedAtUtc","IsSystem","Name") VALUES ($1,$2,now(),FALSE,'Notification manager')`, [roleId, owner.businessId]);
    await db.pool.query('INSERT INTO "RolePermissions" ("RoleId","Permission","BusinessId") VALUES ($1,$2,$3)', [roleId, 'tasks.manage', owner.businessId]);
    await db.pool.query('INSERT INTO "MembershipRoles" ("MembershipId","RoleId","BusinessId") VALUES ($1,$2,$3)', [membershipId, roleId, owner.businessId]);
    const ownerMembership = (await db.pool.query(`SELECT membership.\"Id\" FROM \"Memberships\" membership
      JOIN \"AspNetUsers\" appUser ON appUser.\"Id\" = membership.\"UserId\"
      WHERE membership.\"BusinessId\" = $1 AND membership.\"Status\" = 0 AND appUser.\"Email\" = $2`, [owner.businessId, owner.email])).rows[0];
    const task = (await db.pool.query(`SELECT \"Id\" FROM \"ProductionTasks\"
      WHERE \"BusinessId\" = $1 AND \"OrderId\" = $2 AND \"Status\" = 'Pending' AND \"AssignedMembershipId\" IS NULL
      ORDER BY \"Id\" LIMIT 1`, [owner.businessId, ids.order])).rows[0];
    assert.ok(task, 'the generated order must have an unassigned pending task');
    ids.summaryWorkerMembership = membershipId;
    ids.summaryWorkerBusiness = worker.businessId;
    ids.summaryTask = task.Id;
    const outbox = (templateKey) => db.pool.query(`SELECT \"BusinessId\",\"ToAddress\",\"DeduplicationKey\",\"Status\" FROM \"EmailOutbox\"
      WHERE \"TemplateKey\" = $1 AND \"DeduplicationKey\" LIKE $2`, [templateKey, `${templateKey}:${String(task.Id).replaceAll('-', '')}:%`]);

    const assign = await api.call('POST', `/api/tasks/${task.Id}/assign`, {
      token: owner.token, body: { membershipId, override: true, reason: 'integration test assignment' } });
    assert.equal(assign.status, 200, assign.text);
    const assigned = await outbox('task.assignment');
    assert.equal(assigned.rowCount, 1);
    assert.equal(assigned.rows[0].BusinessId, owner.businessId);
    assert.equal(assigned.rows[0].ToAddress.toLowerCase(), worker.email.toLowerCase());
    assert.equal(assigned.rows[0].Status, 'Pending');
    ids.summaryAssignmentEvent = (await db.pool.query(`
      SELECT "Id" FROM "TaskEvents" WHERE "BusinessId" = $1 AND "TaskId" = $2 AND "DataJson"->>'after' = $3
      ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [owner.businessId, task.Id, membershipId])).rows[0].Id;
    const notification = (eventType, membership) => db.pool.query(`SELECT "Body","RecipientMembershipId" FROM "Notifications"
      WHERE "BusinessId" = $1 AND "TargetId" = $2 AND "EventType" = $3 AND "RecipientMembershipId" = $4`,
    [owner.businessId, task.Id, eventType, membership]);
    assert.equal((await notification('task.assignment', membershipId)).rowCount, 1);
    assert.equal((await notification('task.assignment', ownerMembership.Id)).rowCount, 0, 'the actor is not notified about their own assignment');

    const reassign = await api.call('POST', `/api/tasks/${task.Id}/assign`, {
      token: owner.token, body: { membershipId: ownerMembership.Id, override: true, reason: 'integration reassignment' } });
    assert.equal(reassign.status, 200, reassign.text);
    assert.equal((await notification('task.reassigned', membershipId)).rowCount, 1);
    assert.equal((await outbox('task.reassigned')).rows[0].ToAddress.toLowerCase(), worker.email.toLowerCase());

    const issue = await api.call('POST', `/api/my/tasks/${task.Id}/issues`, {
      token: owner.token, body: { type: 'Defect', description: 'Integration test defect report' } });
    assert.equal(issue.status, 200, issue.text);
    const issues = await outbox('task.issue');
    assert.equal(issues.rowCount, 1, 'the manager is notified, but the reporting actor is excluded');
    for (const row of issues.rows) assert.equal(row.BusinessId, owner.businessId);
    assert.equal(issues.rows[0].ToAddress.toLowerCase(), worker.email.toLowerCase());
    assert.ok(!issues.rows.some((row) => row.ToAddress.toLowerCase() === outsider.email.toLowerCase()), 'other businesses are never notified');
    const issueNotice = await notification('task.issue', membershipId);
    assert.equal(issueNotice.rowCount, 1);
    assert.ok(!issueNotice.rows[0].Body.includes('Integration test defect report'), 'free-text issue details stay out of notification text');

    const unblock = await api.call('POST', `/api/tasks/${task.Id}/unblock`, { token: owner.token, body: { note: 'resolved in test' } });
    assert.equal(unblock.status, 200, unblock.text);
    const unblocked = await outbox('task.unblocked');
    assert.equal(unblocked.rowCount, 0, 'the actor is not emailed about their own unblock action');

    // Re-assigning the same worker is a no-op and must not queue another message.
    const again = await api.call('POST', `/api/tasks/${task.Id}/assign`, { token: owner.token, body: { membershipId: ownerMembership.Id } });
    assert.equal(again.status, 200, again.text);
    assert.equal((await outbox('task.assignment')).rowCount, 1);
  });

  it('persists morning/evening summaries, deduplicates TaskEvent UUIDs, and never crosses businesses', async () => {
    const summaryDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const eventAtUtc = new Date(`${summaryDate}T10:00:00.000Z`);
    const runAt = new Date(`${summaryDate}T18:00:00.000Z`);
    await db.pool.query('UPDATE "Businesses" SET "TimeZoneId" = \'UTC\' WHERE "Id" = $1', [owner.businessId]);
    await db.pool.query('UPDATE "TaskEvents" SET "CreatedAtUtc" = $1 WHERE "BusinessId" = $2 AND "Id" = $3',
      [eventAtUtc, owner.businessId, ids.summaryAssignmentEvent]);

    const queued = await enqueueDueWorkerSummaryJobs(db.pool, { now: runAt });
    assert.ok(queued >= 2, 'both worker and owner summaries are queued for assigned work');
    const first = await runWorkerSummaryCycle(db.pool, { now: runAt, log: quiet });
    assert.ok(first.sent >= 2);

    const job = (await db.pool.query(`
      SELECT "Id", "Status" FROM "WorkerSummaryJobs"
      WHERE "BusinessId" = $1 AND "RecipientMembershipId" = $2 AND "SummaryType" = 'end_of_day' AND "SummaryDate" = $3::date`,
    [owner.businessId, ids.summaryWorkerMembership, summaryDate])).rows[0];
    assert.equal(job.Status, 'Sent');
    const item = await db.pool.query(`SELECT "EventId" FROM "WorkerSummaryEvents" WHERE "SummaryJobId" = $1 AND "BusinessId" = $2`,
      [job.Id, owner.businessId]);
    assert.deepEqual(item.rows.map((row) => row.EventId), [ids.summaryAssignmentEvent]);
    const notice = await db.pool.query(`SELECT count(*)::int AS n FROM "Notifications"
      WHERE "BusinessId" = $1 AND "RecipientMembershipId" = $2 AND "EventType" = 'worker-summary.end-of-day'`,
    [owner.businessId, ids.summaryWorkerMembership]);
    assert.equal(notice.rows[0].n, 1);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "WorkerSummaryJobs" WHERE "BusinessId" = $1', [ids.summaryWorkerBusiness])).rows[0].n, 0);

    const second = await runWorkerSummaryCycle(db.pool, { now: new Date(runAt.getTime() + 60_000), log: quiet });
    assert.equal(second.claimed, 0);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "WorkerSummaryEvents"
      WHERE "BusinessId" = $1 AND "RecipientMembershipId" = $2 AND "SummaryType" = 'end_of_day' AND "EventId" = $3`,
    [owner.businessId, ids.summaryWorkerMembership, ids.summaryAssignmentEvent])).rows[0].n, 1);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "Notifications"
      WHERE "BusinessId" = $1 AND "RecipientMembershipId" = $2 AND "EventType" = 'worker-summary.end-of-day'`,
    [owner.businessId, ids.summaryWorkerMembership])).rows[0].n, 1);
  });

  it('invoice -> issue -> payment -> verify -> receipt', async () => {
    const draft = await api.call('POST', `/api/invoices/from-order/${ids.order}`, { token: owner.token, body: { mode: 'Full' } });
    assert.equal(draft.status, 201, draft.text);
    assert.equal(draft.body.status, 'Draft');
    ids.invoice = draft.body.id;
    const total = draft.body.total;
    assert.ok(total >= 40000);
    assert.equal((await api.call('POST', `/api/invoices/${ids.invoice}/payments`, { token: owner.token, body: { amount: total, method: 'Cash' } })).status, 409, 'draft invoices take no payments');
    const issued = await api.call('POST', `/api/invoices/${ids.invoice}/issue`, { token: owner.token });
    assert.equal(issued.status, 200, issued.text);
    assert.equal(issued.body.status, 'Issued');
    const partial = await api.call('POST', `/api/invoices/${ids.invoice}/payments`, { token: owner.token, body: { amount: 1000, method: 'Cash' } });
    assert.equal(partial.status, 403);
    assert.equal(partial.body.code, 'feature_not_in_plan', 'the free plan has no partial payments');
    const over = await api.call('POST', `/api/invoices/${ids.invoice}/payments`, { token: owner.token, body: { amount: total + 1, method: 'Cash' } });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'overpayment');
    const payment = await api.call('POST', `/api/invoices/${ids.invoice}/payments`, { token: owner.token, body: { amount: total, method: 'BankTransfer', reference: 'TRF-1' }, headers: { 'idempotency-key': 'pay-1' } });
    assert.equal(payment.status, 201, payment.text);
    assert.equal(payment.body.status, 'Pending');
    const replay = await api.call('POST', `/api/invoices/${ids.invoice}/payments`, { token: owner.token, body: { amount: total, method: 'BankTransfer', reference: 'TRF-1' }, headers: { 'idempotency-key': 'pay-1' } });
    assert.equal(replay.status, 200, 'the same idempotency key replays the first result');
    assert.equal(replay.body.id, payment.body.id);
    const verified = await api.call('POST', `/api/payments/${payment.body.id}/verify`, { token: owner.token });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.status, 'Verified');
    const receipt = await api.call('GET', `/api/payments/${payment.body.id}/receipt`, { token: owner.token });
    assert.equal(receipt.status, 200, receipt.text);
    assert.equal(receipt.body.amount, total);
    assert.match(receipt.body.number, /\d/);
    const paid = await api.call('GET', `/api/invoices/${ids.invoice}`, { token: owner.token });
    assert.equal(paid.body.status, 'Issued', 'invoice lifecycle status stays Issued (Draft | Issued | Void)');
    assert.equal(paid.body.paymentStatus, 'Paid', 'payment status is derived from verified payments');
    assert.equal(paid.body.balance, 0);
    assert.equal(paid.body.amountPaid, total);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "Receipts" WHERE "PaymentId" = $1', [payment.body.id])).rows[0].n, 1);
  });

  it('another business cannot see or touch this business\'s data', async () => {
    other = await signUp(api, 'zed');
    for (const p of [`/api/designs/${ids.design}`, `/api/orders/${ids.order}`, `/api/invoices/${ids.invoice}`, `/api/customers/${ids.customer}`]) {
      assert.equal((await api.call('GET', p, { token: other.token })).status, 404, p);
    }
    assert.equal((await api.call('POST', `/api/invoices/${ids.invoice}/void`, { token: other.token, body: { reason: 'attack attempt' } })).status, 404);
    assert.equal((await api.call('POST', `/api/orders/${ids.order}/generate-tasks`, { token: other.token, body: {} })).status, 404);
    const theirs = await api.call('GET', '/api/designs', { token: other.token });
    assert.equal(theirs.body.totalCount, 0);
    const swapped = await api.call('POST', '/api/orders', { token: other.token, body: {
      customerId: ids.customer, locationId, promisedDate: '2099-01-01', garments: [{ name: 'Steal', quantity: 1, unitPrice: 1 }] } });
    assert.ok([400, 404].includes(swapped.status), `cross-business customer/location must be rejected, got ${swapped.status}`);
  });

  it('moves the legacy storefront analytics flag without losing its enabled state', async () => {
    await db.pool.query('DROP TABLE "StorefrontAnalyticsSettings"');
    await db.pool.query('ALTER TABLE "Businesses" ADD COLUMN "StorefrontAnalyticsEnabled" boolean NOT NULL DEFAULT FALSE');
    await db.pool.query('UPDATE "Businesses" SET "StorefrontAnalyticsEnabled" = TRUE WHERE "Id" = $1', [owner.businessId]);
    const migration = await readFile(path.join(MIGRATIONS_DIR, '0020_storefront_analytics_settings.sql'), 'utf8');
    await db.pool.query(migration);

    const settings = await db.pool.query('SELECT "Enabled" FROM "StorefrontAnalyticsSettings" WHERE "BusinessId" = $1', [owner.businessId]);
    assert.deepEqual(settings.rows, [{ Enabled: true }]);
    const legacyColumn = await db.pool.query(`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Businesses' AND column_name = 'StorefrontAnalyticsEnabled'
    ) AS present`);
    assert.equal(legacyColumn.rows[0].present, false);
  });
});
