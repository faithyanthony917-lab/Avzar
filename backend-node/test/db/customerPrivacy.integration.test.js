// End-to-end customer data export/deletion requests on a database built only from Node migrations.
// Includes tenant-isolation checks. Skipped unless DATABASE_URL is configured (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();

function startApp(pool) {
  const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars', WEB_BASE_URL: 'https://app.example.test', STORAGE_LOCAL_ROOT: path.join(os.tmpdir(), 'avzar-customer-privacy-media') });
  const app = createApp(env, pool);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
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
      let json = null; try { json = JSON.parse(text); } catch { /* non-JSON response */ }
      return { status: response.status, body: json, text };
    };
    resolve({ call, close: () => new Promise((done) => { app.locals.objectStorage.close(); server.close(done); }) });
  }));
}

describe('customer privacy requests on a database built only from Node migrations', { skip: !url }, () => {
  let db; let api;
  async function signUp(label) {
    const email = `${label}-${Date.now()}@example.test`;
    const registered = await api.call('POST', '/api/auth/register-business', { body: { businessName: `${label} Tailors`, ownerName: `${label} Owner`, email, password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
    assert.equal(registered.status, 201, registered.text);
    const login = await api.call('POST', '/api/auth/token', { body: { email, password: PASSWORD, deviceName: 'integration' } });
    assert.equal(login.status, 200, login.text);
    return { token: login.body.accessToken, businessId: login.body.user.businessId };
  }
  async function addCustomer(owner, label) {
    const result = await api.call('POST', '/api/customers', { token: owner.token, body: { fullName: `${label} Customer`, email: `${label}-${Date.now()}@example.test` } });
    assert.equal(result.status, 201, result.text);
    return result.body;
  }
  async function grantPortal(customer, owner) {
    const token = randomBytes(32).toString('base64url');
    await db.pool.query(`INSERT INTO "CustomerPortalGrants" ("Id", "BusinessId", "CustomerId", "TokenHash", "ExpiresAtUtc", "RevokedAtUtc", "LastUsedAtUtc", "UseCount", "CreatedAtUtc")
      VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '7 days', NULL, NULL, 0, now())`, [owner.businessId, customer.id, sha256(token)]);
    return token;
  }

  before(async () => {
    db = await createTempDatabase(url, 'avzar_customer_privacy');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('creates idempotent requests, allows review, and prevents cross-tenant access', async () => {
    const ownerA = await signUp('privacy-a');
    const ownerB = await signUp('privacy-b');
    const customerA = await addCustomer(ownerA, 'privacy-a');
    const customerB = await addCustomer(ownerB, 'privacy-b');
    const portalToken = await grantPortal(customerA, ownerA);

    const exportSubmitted = await api.call('POST', '/api/customer-portal/privacy-requests', { body: { token: portalToken, type: 'Export', note: 'Please send me a copy of my information.' } });
    assert.equal(exportSubmitted.status, 201, exportSubmitted.text);
    assert.equal(exportSubmitted.body.request.type, 'Export');
    const submitted = await api.call('POST', '/api/customer-portal/privacy-requests', { body: { token: portalToken, type: 'Deletion', note: 'Please remove my personal details.' } });
    assert.equal(submitted.status, 201, submitted.text);
    assert.equal(submitted.body.request.status, 'Pending');
    const duplicate = await api.call('POST', '/api/customer-portal/privacy-requests', { body: { token: portalToken, type: 'Deletion' } });
    assert.equal(duplicate.status, 200, duplicate.text);
    assert.equal(duplicate.body.alreadyPending, true);
    assert.equal(duplicate.body.request.id, submitted.body.request.id);

    const portalList = await api.call('POST', '/api/customer-portal/privacy-requests/list', { body: { token: portalToken } });
    assert.equal(portalList.status, 200, portalList.text);
    assert.equal(portalList.body.requests.length, 2);
    assert.deepEqual(portalList.body.requests.map((request) => request.type).sort(), ['Deletion', 'Export']);

    const leaked = await api.call('GET', `/api/customers/${customerA.id}/privacy-requests`, { token: ownerB.token });
    assert.equal(leaked.status, 404, leaked.text);
    const wrongTenantReview = await api.call('POST', `/api/customers/${customerA.id}/privacy-requests/${submitted.body.request.id}/review`, { token: ownerB.token, body: { status: 'Approved' } });
    assert.equal(wrongTenantReview.status, 404, wrongTenantReview.text);
    const ownCustomerRequests = await api.call('GET', `/api/customers/${customerB.id}/privacy-requests`, { token: ownerB.token });
    assert.equal(ownCustomerRequests.status, 200, ownCustomerRequests.text);
    assert.deepEqual(ownCustomerRequests.body, []);

    const approved = await api.call('POST', `/api/customers/${customerA.id}/privacy-requests/${submitted.body.request.id}/review`, { token: ownerA.token, body: { status: 'Approved', staffNote: 'We will review records that must be retained.' } });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.status, 'Approved');
    const completed = await api.call('POST', `/api/customers/${customerA.id}/privacy-requests/${submitted.body.request.id}/review`, { token: ownerA.token, body: { status: 'Completed' } });
    assert.equal(completed.status, 200, completed.text);
    assert.equal(completed.body.status, 'Completed');
    const forbiddenTransition = await api.call('POST', `/api/customers/${customerA.id}/privacy-requests/${submitted.body.request.id}/review`, { token: ownerA.token, body: { status: 'Denied' } });
    assert.equal(forbiddenTransition.status, 409, forbiddenTransition.text);
  });
});
