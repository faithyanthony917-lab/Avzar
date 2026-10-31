// Step 16b: customer messages about an order or a payment, on real PostgreSQL through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: only a customer with a current OptedIn record and no standing stop is queued (per channel), a dry-run amend queues nothing,
// the three hooks queue once with their keys, the dispatcher sends with the opt-out text and marks the rows Sent, a withdrawn consent
// cancels what is still waiting, the staff list shows masked numbers to people who may see customers only, and another business sees nothing.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { forEachBusiness, sumResults } from '../../src/db/forEachBusiness.js';
import { dispatchCustomerEventsOnce } from '../../src/messaging/customerEventWorker.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, paidInvoice, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const silent = { error() {}, info() {} };
const PHONE = '+2348011112222';
const ENV = { JWT_SIGNING_KEY: 'k'.repeat(40), WEB_BASE_URL: 'https://app.example.com/' };

describe('customer event messages on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let viewer; let o1; let o2; let o3; let location; let paid;
  const events = async (customerId, businessId = owner.businessId) => (await db.pool.query(`SELECT "Kind", "Channel", "Status", "SubjectId", "DedupeKey", "Address"
    FROM "CustomerEventOutbox" WHERE "BusinessId" = $1 AND "CustomerId" = $2 ORDER BY "CreatedAtUtc", "Id"`, [businessId, customerId])).rows;
  const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const amendmentBody = async (orderId, overrides = {}) => {
    const response = await api.call('GET', `/api/orders/${orderId}`, { token: owner.token });
    assert.equal(response.status, 200, response.text);
    const order = response.body;
    return {
      version: order.version, locationId: order.locationId, promisedDate: order.promisedDate, priority: order.priority,
      deliveryMethod: order.deliveryMethod, deliveryAddress: order.deliveryAddress, deliveryInstructions: order.deliveryInstructions,
      notes: order.notes, discount: order.discount,
      garments: order.garments.map((g) => ({ id: g.id, name: g.name, category: g.category, quantity: g.quantity, unitPrice: g.unitPrice, fabric: g.fabric,
        colour: g.colour, styleInstructions: g.styleInstructions, alterationNotes: g.alterationNotes, measurementSetId: g.measurementSetId,
        measurementRevision: g.measurementRevision, designId: g.designId })),
      ...overrides,
    };
  };
  const consent = (who, customerId, channel, status, note = 'Agreed at the fitting') => api.call('PUT', `/api/customers/${customerId}/messaging-preferences/${channel}`,
    { token: who.token, body: { address: PHONE, consent: status, note } });
  const dispatch = async (provider) => sumResults(await forEachBusiness(role.pool, () => dispatchCustomerEventsOnce(role.pool,
    { provider, env: ENV, now: new Date(), log: silent }), { log: silent }));

  before(async () => {
    db = await createTempDatabase(url, 'avzar_customer_events');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'ce-owner');
    other = await signUp(api, 'ce-other');
    await upgradePlan(db, owner.businessId, 'starter');
    viewer = await addStaff(api, db, owner, 'ce-viewer', ['customers.view']);
    location = await firstLocationId(db, owner.businessId);
    o1 = await confirmedOrder(api, db, owner, location, 'ce1');
    o2 = await confirmedOrder(api, db, owner, location, 'ce2');
    o3 = await confirmedOrder(api, db, owner, location, 'ce3');
    assert.equal((await consent(owner, o1.customerId, 'SMS', 'OptedIn')).status, 200);
    assert.equal((await consent(owner, o1.customerId, 'WhatsApp', 'OptedIn')).status, 200);
    assert.equal((await consent(owner, o3.customerId, 'SMS', 'OptedIn')).status, 200);
    // A standing sender-wide stop on the WhatsApp number: that channel must never be queued, SMS still is.
    await db.pool.query(`INSERT INTO "MessagingSuppressions" ("Id","Channel","Address","Source") VALUES ($1,'WhatsApp',$2,'ProviderRefusal')`, [randomUUID(), PHONE]);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('an amended order queues one message for the opted-in channel that has no stop, a dry run queues none, and an unconsented customer gets none', async () => {
    const preview = await api.call('POST', `/api/orders/${o1.orderId}/amend/preview`, { token: owner.token, body: await amendmentBody(o1.orderId, { promisedDate: days(20) }) });
    assert.equal(preview.status, 200, preview.text);
    assert.equal((await events(o1.customerId)).length, 0, 'a dry run is rolled back and queues nothing');

    const amended = await api.call('POST', `/api/orders/${o1.orderId}/amend`, { token: owner.token, body: await amendmentBody(o1.orderId, { promisedDate: days(20) }) });
    assert.equal(amended.status, 200, amended.text);
    const rows = await events(o1.customerId);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].Kind, rows[0].Channel, rows[0].Status, rows[0].SubjectId], ['order.amended', 'SMS', 'Pending', o1.orderId]);
    assert.match(rows[0].DedupeKey, new RegExp(`^order\\.amended:${o1.orderId}:\\d+$`));

    const otherAmend = await api.call('POST', `/api/orders/${o2.orderId}/amend`, { token: owner.token, body: await amendmentBody(o2.orderId, { promisedDate: days(21) }) });
    assert.equal(otherAmend.status, 200, otherAmend.text);
    assert.equal((await events(o2.customerId)).length, 0);
  });

  it('the last task finishing makes the order Ready and queues one ready message', async () => {
    const tasks = (await db.pool.query(`SELECT "Id" FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Pending' ORDER BY "StageOrder", "Id"`,
      [owner.businessId, o1.orderId])).rows.map((row) => row.Id);
    assert.ok(tasks.length >= 2, 'the generated workflow has several pending tasks');
    const last = tasks.pop();
    await db.pool.query(`UPDATE "ProductionTasks" SET "Status" = 'Completed' WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`, [owner.businessId, tasks]);
    const cancelled = await api.call('POST', `/api/tasks/${last}/cancel`, { token: owner.token, body: { reason: 'Not needed for this order' } });
    assert.equal(cancelled.status, 200, cancelled.text);
    const order = (await db.pool.query('SELECT "Status" FROM "Orders" WHERE "Id" = $1', [o1.orderId])).rows[0];
    assert.equal(order.Status, 'Ready');
    const ready = (await events(o1.customerId)).filter((row) => row.Kind === 'order.ready');
    assert.equal(ready.length, 1);
    assert.deepEqual([ready[0].Channel, ready[0].Status, ready[0].SubjectId], ['SMS', 'Pending', o1.orderId]);
    assert.equal((await events(o2.customerId)).length, 0);
  });

  it('a verified payment queues one receipt message keyed by the payment, and an unconsented customer gets none', async () => {
    paid = await paidInvoice(api, owner, o1.orderId);
    const receipts = (await events(o1.customerId)).filter((row) => row.Kind === 'payment.receipt');
    assert.equal(receipts.length, 1);
    assert.deepEqual([receipts[0].Channel, receipts[0].SubjectId, receipts[0].DedupeKey], ['SMS', paid.paymentId, `payment.receipt:${paid.paymentId}`]);
    await paidInvoice(api, owner, o2.orderId);
    assert.equal((await events(o2.customerId)).length, 0);
  });

  it('the dispatcher sends all three with the opt-out text, marks them Sent, and sends nothing twice', async () => {
    const sent = [];
    const provider = { async send(message) { sent.push(message); return { providerMessageId: `prov-${sent.length}` }; } };
    const first = await dispatch(provider);
    assert.deepEqual([first.claimed, first.sent, first.cancelled, first.failed], [3, 3, 0, 0], JSON.stringify(first));
    assert.equal(sent.length, 3);
    assert.ok(sent.every((message) => message.channel === 'SMS' && message.to === PHONE && /Reply STOP to opt out\. Unsubscribe: https:\/\/app\.example\.com\//.test(message.text)));
    assert.ok(sent.some((message) => /was changed\. Promised date: /.test(message.text)));
    assert.ok(sent.some((message) => /is ready\. It is ready for collection\./.test(message.text)));
    assert.ok(sent.some((message) => /^Receipt RCT-\d{4}-\d{5} from /.test(message.text)));
    const statuses = (await events(o1.customerId)).map((row) => row.Status);
    assert.deepEqual(statuses, ['Sent', 'Sent', 'Sent']);
    const second = await dispatch(provider);
    assert.equal(second.claimed, 0);
    assert.equal(sent.length, 3);
  });

  it('withdrawing consent cancels a message that is still waiting, and nothing is sent for it', async () => {
    const amended = await api.call('POST', `/api/orders/${o3.orderId}/amend`, { token: owner.token, body: await amendmentBody(o3.orderId, { promisedDate: days(25) }) });
    assert.equal(amended.status, 200, amended.text);
    assert.deepEqual((await events(o3.customerId)).map((row) => row.Status), ['Pending']);
    assert.equal((await consent(owner, o3.customerId, 'SMS', 'OptedOut', 'Asked to stop')).status, 200);
    assert.deepEqual((await events(o3.customerId)).map((row) => row.Status), ['Cancelled']);
    const sent = [];
    const result = await dispatch({ async send(message) { sent.push(message); return { providerMessageId: 'x' }; } });
    assert.equal(result.claimed, 0);
    assert.equal(sent.length, 0);
  });

  it('the staff list shows masked numbers, newest first, to people who may view customers only, and never across businesses', async () => {
    const list = await api.call('GET', `/api/customers/${o1.customerId}/messages`, { token: owner.token });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.length, 3);
    assert.ok(list.body.every((row) => row.address === '+234****2222' && !JSON.stringify(row).includes(PHONE)));
    assert.deepEqual(list.body.map((row) => row.status), ['Sent', 'Sent', 'Sent']);
    const times = list.body.map((row) => Date.parse(row.createdAtUtc));
    assert.deepEqual([...times].sort((a, b) => b - a), times);

    assert.equal((await api.call('GET', `/api/customers/${o2.customerId}/messages`, { token: owner.token })).body.length, 0);
    assert.equal((await api.call('GET', `/api/customers/${o1.customerId}/messages`, { token: viewer.token })).status, 200);
    const noPermission = await addStaff(api, db, owner, 'ce-noperm', ['orders.view']);
    assert.equal((await api.call('GET', `/api/customers/${o1.customerId}/messages`, { token: noPermission.token })).status, 403);
    assert.equal((await api.call('GET', `/api/customers/${o1.customerId}/messages`, { token: other.token })).status, 404);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "CustomerEventOutbox" WHERE "BusinessId" = $1', [other.businessId])).rows[0].n, 0);
  });
});
