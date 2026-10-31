// Quotations against a real PostgreSQL built only from the Node migrations: send, customer approval from the portal, conversion to an order,
// the single-version rule (editing and re-issuing invalidates an old link's answer) and tenant isolation.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/http/app.js';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const PASSWORD = 'correct horse battery staple';
const PORTAL = '/api/customer-portal/quotations';

function startApp(pool) {
  const env = loadEnv({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars',
    WEB_BASE_URL: 'https://app.example.test', STORAGE_LOCAL_ROOT: path.join(os.tmpdir(), 'avzar-quotation-media'),
  });
  const app = createApp(env, pool);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    // Staff calls use a bearer token. Portal calls send neither a session nor a CSRF token, exactly like a customer's browser.
    const call = async (method, pathname, { token, body } = {}) => {
      let csrf = {};
      if (!token && !pathname.startsWith('/api/customer-portal/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const issued = await (await fetch(`${base}/api/auth/csrf`)).json();
        csrf = { cookie: `tailoring.csrf=${issued.token}`, 'x-xsrf-token': issued.token };
      }
      const response = await fetch(base + pathname, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: json, text };
    };
    resolve({ call, close: () => new Promise((done) => { app.locals.objectStorage.close(); server.close(done); }) });
  }));
}

describe('quotations on a database built only from the Node migrations', { skip: !url }, () => {
  let db; let api; let ade; let bola;

  async function signUp(label) {
    const email = `${label}-${Date.now()}@example.test`;
    const registered = await api.call('POST', '/api/auth/register-business', {
      body: { businessName: `${label} Tailors`, ownerName: `${label} Owner`, email, password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
    assert.equal(registered.status, 201, registered.text);
    const login = await api.call('POST', '/api/auth/token', { body: { email, password: PASSWORD, deviceName: 'integration' } });
    assert.equal(login.status, 200, login.text);
    const businessId = login.body.user.businessId;
    const locationId = (await db.pool.query('SELECT "Id" FROM "Locations" WHERE "BusinessId" = $1', [businessId])).rows[0].Id;
    return { label, token: login.body.accessToken, businessId, locationId };
  }

  /** A customer with an email and a Quoted order of one garment. */
  async function quotedOrder(owner, garmentName = 'Agbada') {
    const customer = await api.call('POST', '/api/customers', { token: owner.token, body: { fullName: `${owner.label} Customer`, email: `${owner.label}-cust-${Date.now()}@example.test` } });
    assert.equal(customer.status, 201, customer.text);
    const promisedDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const order = await api.call('POST', '/api/orders', { token: owner.token, body: {
      customerId: customer.body.id, locationId: owner.locationId, promisedDate, garments: [{ name: garmentName, quantity: 1, unitPrice: 50000 }] } });
    assert.equal(order.status, 201, order.text);
    const quoted = await api.call('POST', `/api/orders/${order.body.id}/quote`, { token: owner.token });
    assert.equal(quoted.status, 200, quoted.text);
    return { orderId: order.body.id, customerId: customer.body.id };
  }

  /** The portal token only ever travels by email, so read it from the outbox row the send created. */
  async function portalToken(owner) {
    const { rows } = await db.pool.query(`SELECT "TextBody" FROM "EmailOutbox" WHERE "BusinessId" = $1 AND "TemplateKey" = 'quotation_sent' ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [owner.businessId]);
    const match = /customer-portal#([A-Za-z0-9_-]+)/.exec(rows[0].TextBody);
    assert.ok(match, 'the email contains a portal link');
    return match[1];
  }
  const portal = (pathname, body) => api.call('POST', pathname, { body });
  const status = (owner, orderId) => api.call('GET', `/api/orders/${orderId}/quotation`, { token: owner.token });
  const send = (owner, orderId) => api.call('POST', `/api/orders/${orderId}/quotation/send`, { token: owner.token });

  before(async () => {
    db = await createTempDatabase(url, 'avzar_quotations');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
    ade = await signUp('ade');
    bola = await signUp('bola');
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('sends the quotation by email with a portal link and without garment details, and records the event', async () => {
    const { orderId } = await quotedOrder(ade);
    assert.equal((await status(ade, orderId)).body.state, 'NotSent');
    const sent = await send(ade, orderId);
    assert.equal(sent.status, 200, sent.text);
    assert.match(sent.body.maskedEmail, /\*/);

    const mail = (await db.pool.query(`SELECT * FROM "EmailOutbox" WHERE "BusinessId" = $1 AND "TemplateKey" = 'quotation_sent'`, [ade.businessId])).rows;
    assert.equal(mail.length, 1);
    assert.match(mail[0].TextBody, /ORD-/);
    assert.equal(/Agbada/.test(mail[0].TextBody + mail[0].HtmlBody), false, 'no garment details in the email');
    const current = (await status(ade, orderId)).body;
    assert.equal(current.state, 'Sent');
    assert.equal(current.canSend, true);
    assert.equal(current.sendCount, 1);
    const audit = await db.pool.query(`SELECT 1 FROM "AuditLogs" WHERE "BusinessId" = $1 AND "EntityId" = $2 AND "Action" = 'quotation.sent'`, [ade.businessId, orderId]);
    assert.equal(audit.rows.length, 1);

    const again = await send(ade, orderId);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'quotation_recently_sent');
  });

  it('refuses to send an order that is not quoted', async () => {
    const customer = await api.call('POST', '/api/customers', { token: ade.token, body: { fullName: 'Draft Customer', email: `draft-${Date.now()}@example.test` } });
    const promisedDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const draft = await api.call('POST', '/api/orders', { token: ade.token, body: { customerId: customer.body.id, locationId: ade.locationId, promisedDate, garments: [{ name: 'Cap', quantity: 1, unitPrice: 5000 }] } });
    const result = await send(ade, draft.body.id);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'quotation_not_open');
  });

  it('keeps businesses apart: another business cannot send, read or answer this quotation', async () => {
    const { orderId } = await quotedOrder(ade, 'Kaftan');
    assert.equal((await send(ade, orderId)).status, 200);
    const adeToken = await portalToken(ade);
    const quotes = (await portal(PORTAL, { token: adeToken })).body.quotations;
    const quote = quotes.find((q) => q.orderId === orderId);
    assert.ok(quote);

    assert.equal((await send(bola, orderId)).status, 404);
    assert.equal((await status(bola, orderId)).status, 404);

    // Bola's own customer, holding a valid portal link of their own, still cannot answer Ade's quotation.
    const mine = await quotedOrder(bola);
    assert.equal((await send(bola, mine.orderId)).status, 200);
    const bolaToken = await portalToken(bola);
    const crossAnswer = await portal(`${PORTAL}/respond`, { token: bolaToken, orderId, quotationId: quote.quotationId, decision: 'approve' });
    assert.equal(crossAnswer.status, 404);
    const bolaList = (await portal(PORTAL, { token: bolaToken })).body.quotations;
    assert.equal(bolaList.some((q) => q.orderId === orderId), false);
    assert.equal((await status(ade, orderId)).body.state, 'Sent', 'the attempt changed nothing');
  });

  it('lets the customer approve once, then staff convert it to an order', async () => {
    const { orderId } = await quotedOrder(ade, 'Senator suit');
    assert.equal((await send(ade, orderId)).status, 200);
    const token = await portalToken(ade);
    const quote = (await portal(PORTAL, { token })).body.quotations.find((q) => q.orderId === orderId);
    assert.equal(quote.decision, null);
    assert.equal(quote.total, 50000);
    assert.deepEqual(quote.lines.map((line) => line.name), ['Senator suit']);
    assert.equal('measurements' in quote, false);

    const stale = await portal(`${PORTAL}/respond`, { token, orderId, quotationId: '00000000-0000-4000-8000-0000000000aa', decision: 'approve' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'quotation_changed');

    const approved = await portal(`${PORTAL}/respond`, { token, orderId, quotationId: quote.quotationId, decision: 'approve', note: 'Please use navy fabric' });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.decision, 'Approved');
    const repeat = await portal(`${PORTAL}/respond`, { token, orderId, quotationId: quote.quotationId, decision: 'approve' });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.alreadyRecorded, true);
    const flip = await portal(`${PORTAL}/respond`, { token, orderId, quotationId: quote.quotationId, decision: 'decline' });
    assert.equal(flip.status, 409);
    assert.equal(flip.body.code, 'quotation_already_answered');
    assert.equal((await db.pool.query(`SELECT 1 FROM "QuotationEvents" WHERE "OrderId" = $1 AND "Type" IN ('Approved', 'Declined')`, [orderId])).rows.length, 1);

    const seen = (await status(ade, orderId)).body;
    assert.equal(seen.state, 'Approved');
    assert.equal(seen.readyToConfirm, true);
    assert.equal(seen.customerNote, 'Please use navy fabric');
    assert.equal(seen.canSend, false);
    assert.equal((await send(ade, orderId)).status, 409);

    const confirmed = await api.call('POST', `/api/orders/${orderId}/confirm`, { token: ade.token });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.body.status, 'Confirmed');
    const late = await portal(`${PORTAL}/respond`, { token, orderId, quotationId: quote.quotationId, decision: 'approve' });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'quotation_not_open');
    assert.equal((await portal(PORTAL, { token })).body.quotations.some((q) => q.orderId === orderId), false);
    assert.equal((await status(ade, orderId)).body.state, 'Approved', 'the approval stays on record after conversion');
  });

  it('records a decline, and a re-issued quotation needs a fresh send and a fresh answer', async () => {
    const { orderId } = await quotedOrder(ade, 'Iro and buba');
    assert.equal((await send(ade, orderId)).status, 200);
    const token = await portalToken(ade);
    const quote = (await portal(PORTAL, { token })).body.quotations.find((q) => q.orderId === orderId);
    const declined = await portal(`${PORTAL}/respond`, { token, orderId, quotationId: quote.quotationId, decision: 'decline', note: 'Too expensive' });
    assert.equal(declined.body.decision, 'Declined');
    assert.equal((await status(ade, orderId)).body.state, 'Declined');

    // Editing a quoted order sends it back to Draft (clearing QuotedAtUtc); issuing it again starts a new quotation version.
    await db.pool.query(`UPDATE "Orders" SET "Status" = 'Draft', "QuotedAtUtc" = NULL WHERE "Id" = $1 AND "BusinessId" = $2`, [orderId, ade.businessId]);
    assert.equal((await api.call('POST', `/api/orders/${orderId}/quote`, { token: ade.token })).status, 200);
    const fresh = (await status(ade, orderId)).body;
    assert.equal(fresh.state, 'NotSent', 'the earlier decline does not apply to the new version');
    assert.equal(fresh.canSend, true);
    const oldLink = await portal(`${PORTAL}/respond`, { token, orderId, quotationId: quote.quotationId, decision: 'approve' });
    assert.equal(oldLink.status, 404, 'a quotation that was never sent in this version cannot be answered');
    assert.equal((await portal(PORTAL, { token })).body.quotations.some((q) => q.orderId === orderId), false);

    assert.equal((await send(ade, orderId)).status, 200);
    const sentAgain = (await portal(PORTAL, { token })).body.quotations.find((q) => q.orderId === orderId);
    assert.notEqual(sentAgain.quotationId, quote.quotationId);
    assert.equal(sentAgain.decision, null);
  });
});
