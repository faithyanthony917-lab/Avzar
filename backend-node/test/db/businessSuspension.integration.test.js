// Step 17c: suspending and reactivating a business, under a NOSUPERUSER, NOBYPASSRLS role. Skipped unless DATABASE_URL is set.
// A suspended business: its staff are refused at once, nobody can sign in to it, its public pages and portal answer "not found",
// every other business is untouched, and reactivation puts it all back. Each change leaves a platform audit entry.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { PASSWORD, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const BASE = '/api/platform-admin';
const sha256Upper = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();

describe('business suspension on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let admin; let target; let bystander;
  const adminEmail = `root-${randomBytes(4).toString('hex')}@example.test`;
  const slug = { target: `sus-${randomBytes(3).toString('hex')}`, bystander: `sus-${randomBytes(3).toString('hex')}` };
  const portalToken = randomBytes(32).toString('base64url');
  const suspend = (who, id, reason = 'Chargeback dispute under review') => api.call('POST', `${BASE}/businesses/${id}/suspend`, { token: who.token, body: { reason } });
  const reactivate = (who, id) => api.call('POST', `${BASE}/businesses/${id}/reactivate`, { token: who.token, body: {} });
  const audit = async (action, entityId) => (await db.pool.query('SELECT "ActorEmail","DetailsJson" FROM "PlatformAuditLogs" WHERE "Action" = $1 AND "EntityId" = $2', [action, entityId])).rows;
  const site = (key) => api.call('GET', `/public/sites/${slug[key]}`);

  async function publishStorefront(businessId, siteSlug) {
    const storefrontId = randomUUID(); const versionId = randomUUID();
    await db.pool.query(`INSERT INTO "Storefronts" ("Id","BusinessId","Slug","Name","Status","TemplateKey","DraftJson","DraftRevision","AllowSearchIndexing","WorkflowBooking","WorkflowContact","WorkflowCustomOrder","WorkflowInquiry","CreatedAtUtc")
      VALUES ($1,$2,$3,'Shop','Draft','luxury','{}',1,false,true,true,true,true,now())`, [storefrontId, businessId, siteSlug]);
    await db.pool.query(`INSERT INTO "StorefrontVersions" ("Id","BusinessId","CreatedAtUtc","DocumentJson","SchemaVersion","StorefrontId","TemplateKey","VersionNumber")
      VALUES ($1,$2,now(),'{"pages":[]}',1,$3,'luxury',1)`, [versionId, businessId, storefrontId]);
    await db.pool.query(`UPDATE "Storefronts" SET "Status" = 'Published', "PublishedVersionId" = $1 WHERE "Id" = $2`, [versionId, storefrontId]);
  }

  before(async () => {
    db = await createTempDatabase(url, 'avzar_suspension');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool, { PLATFORM_ADMIN_EMAILS: adminEmail });
    admin = await signUp(api, 'rootshop', { email: adminEmail });
    target = await signUp(api, 'targetshop');
    bystander = await signUp(api, 'bystander');
    await publishStorefront(target.businessId, slug.target);
    await publishStorefront(bystander.businessId, slug.bystander);
    const customerId = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Ada Customer','Active')`, [customerId, target.businessId]);
    await db.pool.query(`INSERT INTO "CustomerPortalGrants" ("Id","BusinessId","CustomerId","TokenHash","ExpiresAtUtc","UseCount","CreatedAtUtc") VALUES ($1,$2,$3,$4,now() + interval '1 day',0,now())`,
      [randomUUID(), target.businessId, customerId, sha256Upper(portalToken)]);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('everything works before the suspension', async () => {
    assert.equal((await api.call('GET', '/api/customers', { token: target.token })).status, 200);
    assert.equal((await site('target')).status, 200);
    assert.equal((await api.call('POST', '/api/customer-portal/access', { body: { token: portalToken } })).status, 200);
  });

  it('only a platform administrator can suspend or reactivate; the answer for anyone else is 403, and 401 when not signed in', async () => {
    for (const path of ['suspend', 'reactivate']) {
      const r = await api.call('POST', `${BASE}/businesses/${target.businessId}/${path}`, { token: bystander.token, body: { reason: 'Testing the guard' } });
      assert.equal(r.status, 403, r.text);
      assert.equal(r.body.code, 'platform_admin_required');
      assert.equal((await api.call('POST', `${BASE}/businesses/${target.businessId}/${path}`, { body: { reason: 'Testing the guard' } })).status, 401);
    }
    assert.equal((await db.pool.query('SELECT "IsActive" FROM "Businesses" WHERE "Id" = $1', [target.businessId])).rows[0].IsActive, true);
  });

  it('refuses a missing reason, an unknown business and the administrator\'s own business', async () => {
    assert.equal((await api.call('POST', `${BASE}/businesses/${target.businessId}/suspend`, { token: admin.token, body: {} })).status, 400);
    assert.equal((await suspend(admin, target.businessId, 'ab')).status, 400);
    assert.equal((await suspend(admin, randomUUID())).status, 404);
    const own = await suspend(admin, admin.businessId);
    assert.equal(own.status, 409, own.text);
    assert.equal(own.body.code, 'cannot_suspend_own_business');
    assert.equal((await reactivate(admin, bystander.businessId)).body.code, 'not_suspended', 'an active business cannot be "reactivated"');
  });

  it('suspending switches the business off, records why, and leaves exactly one audit entry', async () => {
    const r = await suspend(admin, target.businessId);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.isActive, false);
    const row = (await db.pool.query('SELECT "IsActive","SuspendedAtUtc","SuspendedReason" FROM "Businesses" WHERE "Id" = $1', [target.businessId])).rows[0];
    assert.equal(row.IsActive, false);
    assert.ok(row.SuspendedAtUtc);
    assert.equal(row.SuspendedReason, 'Chargeback dispute under review');
    const entries = await audit('platform.business.suspended', target.businessId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ActorEmail, adminEmail.toLowerCase());
    assert.equal(entries[0].DetailsJson.reason, 'Chargeback dispute under review');
    const again = await suspend(admin, target.businessId);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_suspended');
    assert.equal((await audit('platform.business.suspended', target.businessId)).length, 1, 'a refused second suspension writes nothing');
  });

  it('the business detail shows the suspension to the administrator', async () => {
    const r = await api.call('GET', `${BASE}/businesses/${target.businessId}`, { token: admin.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.isActive, false);
    assert.equal(r.body.suspendedReason, 'Chargeback dispute under review');
    assert.ok(r.body.suspendedAtUtc);
  });

  it('its staff are refused at once, and nobody can sign in to it', async () => {
    const r = await api.call('GET', '/api/customers', { token: target.token });
    assert.equal(r.status, 401, r.text);
    assert.equal(r.body.code, 'business_suspended');
    const login = await api.call('POST', '/api/auth/token', { body: { email: target.email, password: PASSWORD, deviceName: 'after suspension' } });
    assert.equal(login.status, 403, login.text);
    assert.equal(login.body.code, 'business_suspended');
  });

  it('its public storefront and customer portal answer as if they did not exist', async () => {
    const s = await site('target');
    assert.equal(s.status, 404, s.text);
    assert.equal(s.body.code, 'site_not_found');
    assert.equal((await api.call('GET', `/public/sites/${slug.target}/designs`)).status, 404);
    assert.equal((await api.call('GET', `/public/resolve-slug/${slug.target}`)).status, 404);
    const portal = await api.call('POST', '/api/customer-portal/access', { body: { token: portalToken } });
    assert.ok(portal.status >= 400 && portal.status < 500, `portal answered ${portal.status}`);
  });

  it('another business is untouched: staff, sign-in and public pages all still work', async () => {
    assert.equal((await api.call('GET', '/api/customers', { token: bystander.token })).status, 200);
    assert.equal((await api.call('POST', '/api/auth/token', { body: { email: bystander.email, password: PASSWORD, deviceName: 'other' } })).status, 200);
    assert.equal((await site('bystander')).status, 200);
  });

  it('reactivating puts everything back and leaves an audit entry with the earlier reason', async () => {
    const r = await reactivate(admin, target.businessId);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.isActive, true);
    const row = (await db.pool.query('SELECT "IsActive","SuspendedAtUtc","SuspendedReason" FROM "Businesses" WHERE "Id" = $1', [target.businessId])).rows[0];
    assert.deepEqual([row.IsActive, row.SuspendedAtUtc, row.SuspendedReason], [true, null, null]);
    const entries = await audit('platform.business.reactivated', target.businessId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].DetailsJson.previousReason, 'Chargeback dispute under review');
    assert.equal((await api.call('GET', '/api/customers', { token: target.token })).status, 200);
    assert.equal((await api.call('POST', '/api/auth/token', { body: { email: target.email, password: PASSWORD, deviceName: 'back' } })).status, 200);
    assert.equal((await site('target')).status, 200);
    assert.equal((await api.call('POST', '/api/customer-portal/access', { body: { token: portalToken } })).status, 200);
    assert.equal((await reactivate(admin, target.businessId)).body.code, 'not_suspended');
  });

  it('a provider payment webhook for a suspended business is still recorded (money already paid is never lost)', async () => {
    // The payment, email and subscription lookups are deliberately outside the suspendable set.
    const { SUSPENDABLE_LOOKUPS } = await import('../../src/db/tenantLookup.js');
    for (const kept of ['rtw_payment_reference', 'invoice_payment_reference', 'subscription_payment_reference', 'email_provider_message_id', 'invitation_token_hash', 'session_token_hash', 'storefront_id']) {
      assert.equal(SUSPENDABLE_LOOKUPS.has(kept), false, kept);
    }
    for (const blocked of ['storefront_slug', 'storefront_redirect_slug', 'storefront_hostname', 'portal_token_hash', 'calendar_token_hash', 'media_asset_id']) {
      assert.equal(SUSPENDABLE_LOOKUPS.has(blocked), true, blocked);
    }
  });
});
