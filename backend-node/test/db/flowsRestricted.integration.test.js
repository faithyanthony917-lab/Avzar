// Step-09c: a trimmed copy of the end-to-end flows, run entirely through a NOSUPERUSER, NOBYPASSRLS role. The app sees only the
// restricted pool (wrapped like src/server.js wraps the real one); fixtures and assertions use the superuser pool. The original
// flows.integration.test.js is left as it is. Not copied: appointments, reminders, summaries and plan limits (other suites cover them).
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { PASSWORD, confirmedOrder, firstLocationId, paidInvoice, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('end-to-end flows through a restricted role', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let locationId;
  const ids = {};

  before(async () => {
    db = await createTempDatabase(url, 'avzar_flows_rls');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    api = await startApp(role.pool);
    owner = await signUp(api, 'fra');
    locationId = await firstLocationId(db, owner.businessId);
  });
  after(async () => {
    await api?.close();
    await role?.close();
    await db?.drop();
  });

  it('the application pool is a restricted role', async () => { await assertRestrictedRole(role.pool); });

  it('register and login work; duplicate email, bad password and a missing token are rejected', async () => {
    const dup = await api.call('POST', '/api/auth/register-business', {
      body: { businessName: 'Dup Tailors', ownerName: 'Dup Owner', email: owner.email, password: PASSWORD, timeZoneId: 'UTC', currencyCode: 'NGN' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'email_in_use');
    assert.equal((await api.call('POST', '/api/auth/token', { body: { email: owner.email, password: 'wrong password here' } })).status, 401);
    assert.equal((await api.call('GET', '/api/designs')).status, 401);
    const me = await api.call('GET', '/api/designs', { token: owner.token });
    assert.equal(me.status, 200, me.text);
  });

  it('creates and lists a design, and publishes a storefront whose public listing shows it', async () => {
    const created = await api.call('POST', '/api/designs', { token: owner.token, body: {
      name: 'Agbada Classic', kind: 'MadeToOrder', tags: ['Wedding'], fabrics: ['Aso Oke'], colours: ['Navy'], sizes: ['M', 'L'], basePrice: 45000, productionDays: 14 } });
    assert.equal(created.status, 201, created.text);
    ids.design = created.body.id;
    ids.designSlug = created.body.slug;
    const list = await api.call('GET', '/api/designs', { token: owner.token });
    assert.deepEqual(list.body.items.map((d) => d.id), [ids.design]);
    const site = await api.call('POST', '/api/storefronts', { token: owner.token, body: { name: 'Fra Tailors', slug: 'fra-tailors' } });
    assert.equal(site.status, 201, site.text);
    assert.equal((await api.call('POST', `/api/storefronts/${site.body.id}/publish`, { token: owner.token, body: {} })).status, 200);
    assert.equal((await api.call('GET', '/public/sites/fra-tailors/designs')).body.totalCount, 0, 'private designs are not public');
    assert.equal((await api.call('POST', `/api/designs/${ids.design}/visibility`, { token: owner.token, body: { visibility: 'Public' } })).status, 200);
    const listing = await api.call('GET', '/public/sites/fra-tailors/designs');
    assert.deepEqual(listing.body.items.map((d) => d.name), ['Agbada Classic']);
    const detail = await api.call('GET', `/public/sites/fra-tailors/designs/${ids.designSlug}`);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual(detail.body.sizes, ['M', 'L']);
  });

  it('order, quotation, customer approval, confirmation, invoice and payment all complete', async () => {
    const confirmed = await confirmedOrder(api, db, owner, locationId, 'fra');
    ids.customer = confirmed.customerId;
    ids.order = confirmed.orderId;
    const tasks = await db.pool.query('SELECT count(*)::int AS n FROM "ProductionTasks" WHERE "OrderId" = $1 AND "BusinessId" = $2', [ids.order, owner.businessId]);
    assert.ok(tasks.rows[0].n > 0, 'confirming the order must generate production tasks');
    const paid = await paidInvoice(api, owner, ids.order);
    ids.invoice = paid.invoiceId;
    const invoice = await api.call('GET', `/api/invoices/${ids.invoice}`, { token: owner.token });
    assert.equal(invoice.status, 200, invoice.text);
  });

  it('another business cannot see or touch this business\'s data', async () => {
    other = await signUp(api, 'frb');
    for (const p of [`/api/designs/${ids.design}`, `/api/orders/${ids.order}`, `/api/invoices/${ids.invoice}`, `/api/customers/${ids.customer}`]) {
      assert.equal((await api.call('GET', p, { token: other.token })).status, 404, p);
    }
    assert.equal((await api.call('POST', `/api/invoices/${ids.invoice}/void`, { token: other.token, body: { reason: 'attack attempt' } })).status, 404);
    assert.equal((await api.call('GET', '/api/designs', { token: other.token })).body.totalCount, 0);
    // The first business's data is intact.
    assert.equal((await api.call('GET', `/api/orders/${ids.order}`, { token: owner.token })).status, 200);
  });
});
