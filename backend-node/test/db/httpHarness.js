// Shared helpers for the HTTP + PostgreSQL suites added in step-09b: start the real app on a real database,
// register businesses over HTTP, add invited staff with a chosen permission set, and walk an order to a paid invoice.
// (flows.integration.test.js keeps its own copies; it is deliberately not changed.)
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/http/app.js';

export const PASSWORD = 'correct horse battery staple';
const sha256Lower = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export function startApp(pool, extraEnv = {}, dependencies = {}) {
  const env = loadEnv({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars',
    WEB_BASE_URL: 'https://app.example.test', STORAGE_LOCAL_ROOT: path.join(os.tmpdir(), 'avzar-http-media'), ...extraEnv,
  });
  const app = createApp(env, pool, dependencies);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, pathname, { token, body, headers, redirect } = {}) => {
      // Like a browser: unsafe requests without a bearer token send the double-submit CSRF cookie and header.
      let csrf = {};
      if (!token && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const issued = await (await fetch(`${base}/api/auth/csrf`)).json();
        csrf = { cookie: `tailoring.csrf=${issued.token}`, 'x-xsrf-token': issued.token };
      }
      const response = await fetch(base + pathname, {
        method,
        redirect,
        headers: { ...(body === undefined || typeof body === 'string' ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...csrf, ...headers },
        body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body), // a string body is sent as is (form posts); the caller sets content-type
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: json, text, location: response.headers.get('location'), contentType: response.headers.get('content-type'), headers: response.headers };
    };
    resolve({ call, close: () => new Promise((done) => { app.locals.objectStorage.close(); server.close(done); }) });
  }));
}

/** Registers a business over HTTP and signs the owner in. Returns the owner's bearer token and business ID. */
export async function signUp(api, label, { email = `${label}-${randomBytes(4).toString('hex')}@example.test` } = {}) {
  const registered = await api.call('POST', '/api/auth/register-business', {
    body: { businessName: `${label} Tailors`, ownerName: `${label} Owner`, email, password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
  assert.equal(registered.status, 201, registered.text);
  const login = await api.call('POST', '/api/auth/token', { body: { email, password: PASSWORD, deviceName: 'integration' } });
  assert.equal(login.status, 200, login.text);
  return { email, token: login.body.accessToken, businessId: login.body.user.businessId };
}

export async function upgradePlan(db, businessId, code = 'starter') {
  await db.pool.query(`UPDATE "Subscriptions" SET "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = $2) WHERE "BusinessId" = $1`, [businessId, code]);
}

/**
 * Adds a staff member to the owner's business with a role holding exactly `permissions`, through a real invitation.
 * The owner is moved to the starter plan first so the staff limit does not get in the way.
 */
export async function addStaff(api, db, owner, label, permissions) {
  await upgradePlan(db, owner.businessId);
  const roleId = randomUUID();
  await db.pool.query(`INSERT INTO "BusinessRoles" ("Id","BusinessId","Name","IsSystem","CreatedAtUtc") VALUES ($1,$2,$3,FALSE,now())`, [roleId, owner.businessId, `${label} role`]);
  for (const permission of permissions) {
    await db.pool.query(`INSERT INTO "RolePermissions" ("RoleId","Permission","BusinessId") VALUES ($1,$2,$3)`, [roleId, permission, owner.businessId]);
  }
  const ownerUserId = (await db.pool.query('SELECT "Id" FROM "AspNetUsers" WHERE "Email" = $1', [owner.email])).rows[0].Id;
  const email = `${label}-${randomBytes(4).toString('hex')}@example.test`;
  const inviteToken = randomBytes(24).toString('base64url');
  await db.pool.query(`
    INSERT INTO "Invitations" ("Id","BusinessId","CreatedAtUtc","Email","ExpiresAtUtc","FullName","InvitedByUserId","TokenHash","RoleIds","LocationIds")
    VALUES ($1,$2,now(),$3, now() + interval '1 day',$4,$5,$6, ARRAY[$7]::uuid[], '{}'::uuid[])`,
  [randomUUID(), owner.businessId, email, `${label} Staff`, ownerUserId, sha256Lower(inviteToken), roleId]);
  const accepted = await api.call('POST', '/api/auth/accept-invitation', { body: { token: inviteToken, password: PASSWORD } });
  assert.equal(accepted.status, 200, accepted.text);
  const login = await api.call('POST', '/api/auth/token', { body: { email, password: PASSWORD, deviceName: 'integration' } });
  assert.equal(login.status, 200, login.text);
  return { email, token: login.body.accessToken, businessId: login.body.user.businessId };
}

export async function firstLocationId(db, businessId) {
  return (await db.pool.query('SELECT "Id" FROM "Locations" WHERE "BusinessId" = $1', [businessId])).rows[0].Id;
}

/** customer -> order (2 x 20,000) -> quote -> sent -> approved through the customer portal -> confirmed (production tasks generated). */
export async function confirmedOrder(api, db, owner, locationId, label = 'harness') {
  const customer = await api.call('POST', '/api/customers', { token: owner.token, body: { fullName: `${label} customer`, email: `${label}-${randomBytes(3).toString('hex')}@example.test`, phone: '+2348012345678', allowDuplicate: true } });
  assert.equal(customer.status, 201, customer.text);
  const promised = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const order = await api.call('POST', '/api/orders', { token: owner.token, body: { customerId: customer.body.id, locationId, promisedDate: promised, garments: [{ name: 'Agbada', quantity: 2, unitPrice: 20000 }] } });
  assert.equal(order.status, 201, order.text);
  const orderId = order.body.id;
  assert.equal((await api.call('POST', `/api/orders/${orderId}/quote`, { token: owner.token })).status, 200);
  assert.equal((await api.call('POST', `/api/orders/${orderId}/quotation/send`, { token: owner.token })).status, 200);
  const email = (await db.pool.query(`SELECT "TextBody" FROM "EmailOutbox" WHERE "BusinessId" = $1 AND "TemplateKey" = 'quotation_sent' ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [owner.businessId])).rows[0];
  const portalToken = /customer-portal#([A-Za-z0-9_-]+)/.exec(email.TextBody)?.[1];
  assert.ok(portalToken, 'the quotation email must contain the customer portal token');
  const portal = await api.call('POST', '/api/customer-portal/quotations', { body: { token: portalToken } });
  const quotation = portal.body.quotations.find((item) => item.orderId === orderId);
  assert.ok(quotation, 'the customer portal must show the quoted order');
  const approved = await api.call('POST', '/api/customer-portal/quotations/respond', { body: { token: portalToken, orderId, quotationId: quotation.quotationId, decision: 'approve' } });
  assert.equal(approved.status, 200, approved.text);
  const confirmed = await api.call('POST', `/api/orders/${orderId}/confirm`, { token: owner.token });
  assert.equal(confirmed.status, 200, confirmed.text);
  return { customerId: customer.body.id, orderId };
}

/** invoice from the order -> issued -> paid in full by bank transfer -> verified. Returns the invoice total and payment ID. */
export async function paidInvoice(api, owner, orderId) {
  const draft = await api.call('POST', `/api/invoices/from-order/${orderId}`, { token: owner.token, body: { mode: 'Full' } });
  assert.equal(draft.status, 201, draft.text);
  const invoiceId = draft.body.id;
  const total = draft.body.total;
  assert.equal((await api.call('POST', `/api/invoices/${invoiceId}/issue`, { token: owner.token })).status, 200);
  const payment = await api.call('POST', `/api/invoices/${invoiceId}/payments`, { token: owner.token, body: { amount: total, method: 'BankTransfer', reference: `TRF-${randomBytes(3).toString('hex')}` }, headers: { 'idempotency-key': `pay-${randomBytes(6).toString('hex')}` } });
  assert.equal(payment.status, 201, payment.text);
  const verified = await api.call('POST', `/api/payments/${payment.body.id}/verify`, { token: owner.token });
  assert.equal(verified.status, 200, verified.text);
  return { invoiceId, total, paymentId: payment.body.id };
}
