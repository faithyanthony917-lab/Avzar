// Step 16c: editable customer message wording, on real PostgreSQL through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: only a person with business.settings may read or change wording; a saved wording is what the dispatcher sends (with the opt-out
// line still added by the sender); another business never sees, uses or overwrites it; the table reads empty and refuses writes without
// a business context; a reset returns to the default; saves and resets are audited without the text.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { forEachBusiness, sumResults } from '../../src/db/forEachBusiness.js';
import { dispatchCustomerEventsOnce } from '../../src/messaging/customerEventWorker.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const silent = { error() {}, info() {} };
const PHONE = '+2348011112222';
const ENV = { JWT_SIGNING_KEY: 'k'.repeat(40), WEB_BASE_URL: 'https://app.example.com/' };
const BASE = '/api/business/message-templates';

describe('message templates on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let viewer; let order; let location;
  const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const put = (who, kind, channel, body) => api.call('PUT', `${BASE}/${kind}/${channel}`, { token: who.token, body: { body } });
  const dispatch = async (provider) => sumResults(await forEachBusiness(role.pool, () => dispatchCustomerEventsOnce(role.pool,
    { provider, env: ENV, now: new Date(), log: silent }), { log: silent }));
  const amendmentBody = async (orderId, overrides = {}) => {
    const response = await api.call('GET', `/api/orders/${orderId}`, { token: owner.token });
    assert.equal(response.status, 200, response.text);
    const o = response.body;
    return {
      version: o.version, locationId: o.locationId, promisedDate: o.promisedDate, priority: o.priority,
      deliveryMethod: o.deliveryMethod, deliveryAddress: o.deliveryAddress, deliveryInstructions: o.deliveryInstructions,
      notes: o.notes, discount: o.discount,
      garments: o.garments.map((g) => ({ id: g.id, name: g.name, category: g.category, quantity: g.quantity, unitPrice: g.unitPrice, fabric: g.fabric,
        colour: g.colour, styleInstructions: g.styleInstructions, alterationNotes: g.alterationNotes, measurementSetId: g.measurementSetId,
        measurementRevision: g.measurementRevision, designId: g.designId })),
      ...overrides,
    };
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_message_templates');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'mt-owner');
    other = await signUp(api, 'mt-other');
    await upgradePlan(db, owner.businessId, 'starter');
    viewer = await addStaff(api, db, owner, 'mt-viewer', ['customers.view', 'customers.manage']);
    location = await firstLocationId(db, owner.businessId);
    order = await confirmedOrder(api, db, owner, location, 'mt1');
    const consent = await api.call('PUT', `/api/customers/${order.customerId}/messaging-preferences/SMS`, { token: owner.token, body: { address: PHONE, consent: 'OptedIn', note: 'Agreed at the fitting' } });
    assert.equal(consent.status, 200, consent.text);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('lists the defaults for a business with nothing saved, and refuses a person without business.settings', async () => {
    const list = await api.call('GET', BASE, { token: owner.token });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.items.length, 4);
    for (const item of list.body.items) for (const channel of item.channels) assert.deepEqual([channel.usingDefault, channel.customBody], [true, null]);
    assert.equal((await api.call('GET', BASE, { token: viewer.token })).status, 403);
    assert.equal((await put(viewer, 'order.amended', 'SMS', 'Changed {order}')).status, 403);
    assert.equal((await api.call('DELETE', `${BASE}/order.amended/SMS`, { token: viewer.token })).status, 403);
    assert.equal((await api.call('POST', `${BASE}/order.amended/preview`, { token: viewer.token, body: { body: 'Hi' } })).status, 403);
  });

  it('saves wording for one kind and channel, and it comes back on the next read; an invalid wording writes nothing', async () => {
    const saved = await put(owner, 'order.amended', 'SMS', 'Your order {order} changed. New date: {promised_date}. - {business}');
    assert.equal(saved.status, 200, saved.text);
    const bad = await put(owner, 'order.amended', 'SMS', 'Click https://evil.example {order}');
    assert.equal(bad.status, 400);
    const list = await api.call('GET', BASE, { token: owner.token });
    const amended = list.body.items.find((item) => item.kind === 'order.amended');
    assert.deepEqual(amended.channels.map((c) => [c.channel, c.usingDefault]), [['SMS', false], ['WhatsApp', true]]);
    assert.equal(amended.channels[0].customBody, 'Your order {order} changed. New date: {promised_date}. - {business}');
    const rows = (await db.pool.query('SELECT "Kind","Channel","Body" FROM "NotificationTemplates" WHERE "BusinessId"=$1', [owner.businessId])).rows;
    assert.equal(rows.length, 1);
    const preview = await api.call('POST', `${BASE}/order.amended/preview`, { token: owner.token, body: { body: 'Hi {business}, {order}' } });
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.body.text, /^Hi .+, ORD-2026-0042$/);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "NotificationTemplates"')).rows[0].n, 1, 'a preview saves nothing');
  });

  it('the dispatcher sends the saved wording, with the opt-out line added after it by the sender', async () => {
    const amended = await api.call('POST', `/api/orders/${order.orderId}/amend`, { token: owner.token, body: await amendmentBody(order.orderId, { promisedDate: days(21) }) });
    assert.equal(amended.status, 200, amended.text);
    const sent = [];
    const result = await dispatch({ async send(message) { sent.push(message); return { providerMessageId: 'p-1' }; } });
    assert.equal(result.sent, 1, JSON.stringify(result));
    assert.match(sent[0].text, /^Your order .+ changed\. New date: .+\. - .+ Reply STOP to opt out\. Unsubscribe: https:\/\/app\.example\.com\//);
    assert.ok(!sent[0].text.includes('Update from'), 'the default wording is not used when wording is saved');
  });

  it('another business neither sees nor uses nor overwrites this wording, and saving the same kind there is separate', async () => {
    const otherList = await api.call('GET', BASE, { token: other.token });
    assert.ok(otherList.body.items.every((item) => item.channels.every((c) => c.usingDefault)), 'the other business sees only defaults');
    assert.equal((await put(other, 'order.amended', 'SMS', 'Other shop wording {order}')).status, 200);
    const ownerList = await api.call('GET', BASE, { token: owner.token });
    assert.equal(ownerList.body.items.find((i) => i.kind === 'order.amended').channels[0].customBody, 'Your order {order} changed. New date: {promised_date}. - {business}');
    const counts = (await db.pool.query('SELECT "BusinessId", count(*)::int AS n FROM "NotificationTemplates" GROUP BY 1')).rows;
    assert.equal(counts.length, 2);
    assert.ok(counts.every((row) => row.n === 1));
    assert.equal((await api.call('DELETE', `${BASE}/order.amended/SMS`, { token: other.token })).status, 200);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "NotificationTemplates" WHERE "BusinessId"=$1', [owner.businessId])).rows[0].n, 1, 'the other business\'s reset leaves this wording alone');
  });

  it('with no business context the table reads empty and refuses writes, and a write for another business is refused', async () => {
    assert.equal((await role.pool.query('SELECT count(*)::int AS n FROM "NotificationTemplates"')).rows[0].n, 0);
    await assert.rejects(() => role.pool.query(`INSERT INTO "NotificationTemplates" ("Id","BusinessId","Kind","Channel","Body") VALUES ($1,$2,'order.ready','SMS','x {order}')`, [randomUUID(), owner.businessId]), /row-level security/);
    const client = await role.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.business_id', $1, true)", [owner.businessId]);
      await assert.rejects(() => client.query(`INSERT INTO "NotificationTemplates" ("Id","BusinessId","Kind","Channel","Body") VALUES ($1,$2,'order.ready','SMS','x {order}')`, [randomUUID(), other.businessId]), /row-level security/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('the database refuses an unknown kind, an unknown channel, a blank body and a second row for the same kind and channel', async () => {
    const insert = (kind, channel, body) => db.pool.query(`INSERT INTO "NotificationTemplates" ("Id","BusinessId","Kind","Channel","Body") VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), other.businessId, kind, channel, body]);
    await assert.rejects(() => insert('staff.leave', 'SMS', 'x'), /CK_NotificationTemplates_Kind/);
    await assert.rejects(() => insert('order.ready', 'Email', 'x'), /CK_NotificationTemplates_Channel/);
    await assert.rejects(() => insert('order.ready', 'SMS', '   '), /CK_NotificationTemplates_Body/);
    await insert('order.ready', 'SMS', 'ok {order}');
    await assert.rejects(() => insert('order.ready', 'SMS', 'again {order}'), /AK_NotificationTemplates_Business_Kind_Channel/);
  });

  it('a reset returns to the default wording, and saves and resets are audited without the text', async () => {
    assert.equal((await api.call('DELETE', `${BASE}/order.amended/SMS`, { token: owner.token })).status, 200);
    const amended = await api.call('POST', `/api/orders/${order.orderId}/amend`, { token: owner.token, body: await amendmentBody(order.orderId, { promisedDate: days(28) }) });
    assert.equal(amended.status, 200, amended.text);
    const sent = [];
    await dispatch({ async send(message) { sent.push(message); return { providerMessageId: 'p-2' }; } });
    assert.match(sent[0].text, /^Update from .+: order .+ was changed\./);
    const audits = (await db.pool.query(`SELECT "DetailsJson" FROM "AuditLogs" WHERE "BusinessId"=$1 AND "Action"='message_template.changed' ORDER BY "CreatedAtUtc"`, [owner.businessId])).rows.map((r) => r.DetailsJson);
    assert.deepEqual(audits.map((d) => d.action), ['saved', 'reset']);
    assert.ok(audits.every((d) => d.kind === 'order.amended' && d.channel === 'SMS' && !JSON.stringify(d).includes('changed')));
  });
});
