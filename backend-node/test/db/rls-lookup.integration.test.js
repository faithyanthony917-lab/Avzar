// Real PostgreSQL behaviour of migrations 0032 + 0033 under a NOSUPERUSER, NOBYPASSRLS, non-owner role.
// Skipped unless DATABASE_URL is set (CI job "node-db"). CI itself connects as a superuser, so this suite is what proves the policies.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { installTenantRlsContext, runWithTenantPlatformScope, runWithTenantRlsContext, setTenantLookup, setTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { bindTenantByLookup } from '../../src/db/tenantLookup.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;

describe('PostgreSQL tenant lookup policies under a restricted role', { skip: !url }, () => {
  let db;
  let roleName;
  let appPool;
  const A = randomUUID();
  const B = randomUUID();
  const storefrontA = randomUUID();
  const storefrontB = randomUUID();
  const slugA = `slug-a-${randomBytes(3).toString('hex')}`;
  const slugB = `slug-b-${randomBytes(3).toString('hex')}`;
  const hashA = randomBytes(32).toString('hex');
  const messageA = `msg-${randomBytes(4).toString('hex')}`;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rls_lookup');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    roleName = `avzar_lookup_${randomBytes(5).toString('hex')}`;
    await db.pool.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await db.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);

    await db.pool.query(`
      INSERT INTO "Businesses" ("Id", "CreatedAtUtc", "CurrencyCode", "IsActive", "Name", "TimeZoneId")
      VALUES ($1, now(), 'NGN', true, 'Lookup A', 'UTC'), ($2, now(), 'NGN', true, 'Lookup B', 'UTC')`, [A, B]);
    for (const [id, biz, slug] of [[storefrontA, A, slugA], [storefrontB, B, slugB]]) {
      await db.pool.query(`
        INSERT INTO "Storefronts" ("Id", "BusinessId", "Slug", "Name", "Status", "TemplateKey", "DraftJson", "DraftRevision", "AllowSearchIndexing",
          "WorkflowBooking", "WorkflowContact", "WorkflowCustomOrder", "WorkflowInquiry", "CreatedAtUtc")
        VALUES ($1, $2, $3, 'Shop', 'Draft', 'luxury', '{}', 1, false, true, true, true, true, now())`, [id, biz, slug]);
    }
    await db.pool.query(`
      INSERT INTO "EmailOutbox" ("Id", "Attempts", "BusinessId", "CreatedAtUtc", "NextAttemptUtc", "Status", "Subject", "TextBody", "ToAddress", "ProviderMessageId")
      VALUES ($1, 0, $2, now(), now(), 'Sent', 's', 't', 'a@example.com', $3), ($4, 0, NULL, now(), now(), 'Pending', 's', 't', 'n@example.com', NULL)`,
    [randomUUID(), A, messageA, randomUUID()]);

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

  it('the application role really is restricted', async () => {
    const { rows } = await appPool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false });
  });

  it('every table with a BusinessId has the 0032 policy, forced RLS, and no context reads nothing', async () => {
    const tables = (await db.pool.query(`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'BusinessId' AND t.table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name);
    assert.ok(tables.length > 0);
    const policies = (await db.pool.query(`SELECT tablename FROM pg_policies WHERE policyname = 'avzar_business_isolation'`)).rows.map((r) => r.tablename);
    assert.deepEqual([...policies].sort(), [...tables].sort(), 'policy count equals table count');
    const forced = (await db.pool.query(`SELECT relname FROM pg_class WHERE relforcerowsecurity AND relkind = 'r'`)).rows.map((r) => r.relname);
    for (const t of tables) assert.ok(forced.includes(t), `${t} forces RLS`);
    for (const t of tables) {
      const { rows } = await appPool.query(`SELECT count(*)::int AS n FROM "${t}"`);
      assert.equal(rows[0].n, 0, `${t} readable without context`);
    }
  });

  it('a storefront slug makes only that storefront readable, and only for SELECT', async () => {
    await runWithTenantRlsContext(async () => {
      assert.equal(await bindTenantByLookup(appPool, 'storefront_slug', slugA), A);
      // After adoption the tenant is A: A's rows are visible, B's are not.
      const { rows } = await appPool.query('SELECT "Id" FROM "Storefronts"');
      assert.deepEqual(rows.map((r) => r.Id), [storefrontA]);
    });
    await runWithTenantRlsContext(async () => {
      assert.equal(await bindTenantByLookup(appPool, 'storefront_slug', 'no-such-slug'), null);
      assert.equal((await appPool.query('SELECT count(*)::int AS n FROM "Storefronts"')).rows[0].n, 0);
    });
  });

  it('a lookup key is not a tenant: other tables stay hidden and writes are denied until the business is adopted', async () => {
    await runWithTenantRlsContext(async () => {
      setTenantLookup('storefront_slug', slugA);
      assert.equal((await appPool.query('SELECT count(*)::int AS n FROM "Storefronts"')).rows[0].n, 1);
      assert.equal((await appPool.query('SELECT count(*)::int AS n FROM "EmailOutbox"')).rows[0].n, 0);
      assert.equal((await appPool.query('UPDATE "Storefronts" SET "Name" = \'x\' WHERE "Slug" = $1', [slugA])).rowCount, 0);
      await assert.rejects(
        appPool.query(`INSERT INTO "Storefronts" ("Id","BusinessId","Slug","Name","Status","TemplateKey","DraftJson","DraftRevision","AllowSearchIndexing","WorkflowBooking","WorkflowContact","WorkflowCustomOrder","WorkflowInquiry","CreatedAtUtc")
          VALUES ($1,$2,'x-slug','x','Draft','luxury','{}',1,false,true,true,true,true,now())`, [randomUUID(), A]),
        (error) => error.code === '42501',
      );
    });
  });

  it('a webhook reference finds its outbox row; a request scoped to B cannot', async () => {
    await runWithTenantRlsContext(async () => {
      assert.equal(await bindTenantByLookup(appPool, 'email_provider_message_id', messageA), A);
    });
    await runWithTenantRlsContext(async () => {
      setTenantRlsContext(B);
      assert.equal((await appPool.query('SELECT count(*)::int AS n FROM "EmailOutbox" WHERE "ProviderMessageId" = $1', [messageA])).rows[0].n, 0);
    });
  });

  it('tenantless emails are reachable only in platform scope, and platform scope exposes no business rows', async () => {
    const insert = `INSERT INTO "EmailOutbox" ("Id","Attempts","BusinessId","CreatedAtUtc","NextAttemptUtc","Status","Subject","TextBody","ToAddress")
      VALUES ($1,0,NULL,now(),now(),'Pending','reset','body','u@example.com')`;
    await runWithTenantRlsContext(async () => {
      await assert.rejects(appPool.query(insert, [randomUUID()]), (error) => error.code === '42501');
    });
    await runWithTenantPlatformScope(async () => {
      await appPool.query(insert, [randomUUID()]);
      const { rows } = await appPool.query('SELECT "BusinessId" FROM "EmailOutbox"');
      assert.ok(rows.length >= 2);
      assert.ok(rows.every((r) => r.BusinessId === null), 'no business rows are visible');
      await assert.rejects(
        appPool.query(`INSERT INTO "EmailOutbox" ("Id","Attempts","BusinessId","CreatedAtUtc","NextAttemptUtc","Status","Subject","TextBody","ToAddress")
          VALUES ($1,0,$2,now(),now(),'Pending','x','y','z@example.com')`, [randomUUID(), A]),
        (error) => error.code === '42501',
      );
    });
  });

  it('lookup and business settings do not leak through pooled connections', async () => {
    await runWithTenantRlsContext(async () => {
      await bindTenantByLookup(appPool, 'storefront_slug', slugB);
    });
    for (let i = 0; i < 6; i += 1) {
      await runWithTenantRlsContext(async () => {
        assert.equal((await appPool.query('SELECT count(*)::int AS n FROM "Storefronts"')).rows[0].n, 0, `connection reuse ${i}`);
      });
    }
  });
});
