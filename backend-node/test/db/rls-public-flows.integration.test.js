// The public, token-keyed request paths running against real PostgreSQL as a NOSUPERUSER, NOBYPASSRLS role.
// Skipped unless DATABASE_URL is set (CI job "node-db"). Each path starts with no tenant and must find its business by its own key.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { installTenantRlsContext, runWithTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { accessCustomerPortal } from '../../src/auth/customerPortalService.js';
import { listPublicDesigns } from '../../src/auth/publicSiteRoutes.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const sha256Upper = (value) => createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();

describe('public token-keyed paths under a restricted role', { skip: !url }, () => {
  let db;
  let roleName;
  let appPool;
  const A = randomUUID();
  const B = randomUUID();
  const publishedSlug = `pub-${randomBytes(3).toString('hex')}`;
  const draftSlug = `draft-${randomBytes(3).toString('hex')}`;
  const portalToken = randomBytes(32).toString('base64url');

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rls_public');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    roleName = `avzar_public_${randomBytes(5).toString('hex')}`;
    await db.pool.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await db.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
    await db.pool.query(`
      INSERT INTO "Businesses" ("Id", "CreatedAtUtc", "CurrencyCode", "IsActive", "Name", "TimeZoneId")
      VALUES ($1, now(), 'NGN', true, 'Public A', 'UTC'), ($2, now(), 'NGN', true, 'Public B', 'UTC')`, [A, B]);

    const storefront = (id, biz, slug) => db.pool.query(`
      INSERT INTO "Storefronts" ("Id", "BusinessId", "Slug", "Name", "Status", "TemplateKey", "DraftJson", "DraftRevision", "AllowSearchIndexing",
        "WorkflowBooking", "WorkflowContact", "WorkflowCustomOrder", "WorkflowInquiry", "CreatedAtUtc")
      VALUES ($1, $2, $3, 'Shop', 'Draft', 'luxury', '{}', 1, false, true, true, true, true, now())`, [id, biz, slug]);
    const sfA = randomUUID();
    const sfDraft = randomUUID();
    await storefront(sfA, A, publishedSlug);
    await storefront(sfDraft, B, draftSlug);
    const versionId = randomUUID();
    await db.pool.query(`
      INSERT INTO "StorefrontVersions" ("Id", "BusinessId", "CreatedAtUtc", "DocumentJson", "SchemaVersion", "StorefrontId", "TemplateKey", "VersionNumber")
      VALUES ($1, $2, now(), '{"pages":[]}', 1, $3, 'luxury', 1)`, [versionId, A, sfA]);
    await db.pool.query(`UPDATE "Storefronts" SET "Status" = 'Published', "PublishedVersionId" = $1 WHERE "Id" = $2`, [versionId, sfA]);

    const customerId = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id", "BusinessId", "CreatedAtUtc", "FullName", "Status") VALUES ($1, $2, now(), 'Ada Customer', 'Active')`, [customerId, A]);
    await db.pool.query(`
      INSERT INTO "CustomerPortalGrants" ("Id", "BusinessId", "CustomerId", "TokenHash", "ExpiresAtUtc", "UseCount", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, now() + interval '1 day', 0, now())`, [randomUUID(), A, customerId, sha256Upper(portalToken)]);

    const u = new URL(db.url);
    u.username = roleName;
    u.password = 'pw';
    appPool = installTenantRlsContext(new pg.Pool({ connectionString: u.toString(), max: 3 }));
  });

  after(async () => {
    await appPool?.end().catch(() => {});
    if (db) {
      await db.pool.query(`DROP OWNED BY "${roleName}"`).catch(() => {});
      await db.pool.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => {});
      await db.drop();
    }
  });

  it('a published storefront is found by slug with no tenant context', async () => {
    const result = await runWithTenantRlsContext(() => listPublicDesigns(appPool, publishedSlug, {}));
    assert.deepEqual(result.items, []);
    assert.equal(result.totalCount, 0);
  });

  it('a draft or unknown slug still returns 404', async () => {
    for (const slug of [draftSlug, 'no-such-site']) {
      await assert.rejects(
        runWithTenantRlsContext(() => listPublicDesigns(appPool, slug, {})),
        (error) => error.status === 404 && error.code === 'site_not_found',
      );
    }
  });

  it('the customer portal opens with its token and rejects a wrong one', async () => {
    const portal = await runWithTenantRlsContext(() => accessCustomerPortal(appPool, portalToken));
    assert.equal(portal.customerName, 'Ada Customer');
    assert.equal(portal.businessName, 'Public A');
    await assert.rejects(
      runWithTenantRlsContext(() => accessCustomerPortal(appPool, randomBytes(32).toString('base64url'))),
      (error) => error.code === 'portal_link_invalid',
    );
  });

  it('the portal grant records its use under the right business', async () => {
    const { rows } = await db.pool.query('SELECT "UseCount" FROM "CustomerPortalGrants" WHERE "BusinessId" = $1', [A]);
    assert.equal(rows[0].UseCount, 1);
  });
});
