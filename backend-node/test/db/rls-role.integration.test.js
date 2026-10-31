// Real PostgreSQL RLS behavior under a non-superuser, non-owner role.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;

describe('PostgreSQL RLS with a restricted application-like role', { skip: !url }, () => {
  let db;
  let roleName;
  let client;
  let businessA;
  let businessB;
  const supplierA = randomUUID();
  const supplierB = randomUUID();

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rls_role');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    roleName = `avzar_rls_test_${randomBytes(5).toString('hex')}`;
    await db.pool.query(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await db.pool.query(`GRANT SELECT ON "Businesses" TO "${roleName}"`);
    await db.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "Suppliers" TO "${roleName}"`);

    businessA = randomUUID();
    businessB = randomUUID();
    await db.pool.query(`
      INSERT INTO "Businesses" ("Id", "CreatedAtUtc", "CurrencyCode", "IsActive", "Name", "TimeZoneId")
      VALUES ($1, now(), 'NGN', true, 'RLS tenant A', 'UTC'),
             ($2, now(), 'NGN', true, 'RLS tenant B', 'UTC')`, [businessA, businessB]);
    await db.pool.query(`INSERT INTO "Suppliers" ("Id", "BusinessId", "Name") VALUES ($1, $2, 'Supplier A'), ($3, $4, 'Supplier B')`, [supplierA, businessA, supplierB, businessB]);

    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query(`SET ROLE "${roleName}"`);
  });

  after(async () => {
    await client?.end().catch(() => {});
    if (db) {
      await db.pool.query(`DROP OWNED BY "${roleName}"`).catch(() => {});
      await db.pool.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => {});
      await db.drop();
    }
  });

  it('denies reads and writes without tenant context', async () => {
    await client.query('BEGIN');
    try {
      assert.deepEqual((await client.query('SELECT "Id" FROM "Suppliers"')).rows, []);
      await assert.rejects(
        client.query(`INSERT INTO "Suppliers" ("Id", "BusinessId", "Name") VALUES ($1, $2, 'No context')`, [randomUUID(), businessA]),
        (error) => error.code === '42501',
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('isolates SELECT, UPDATE and DELETE across tenants and rejects cross-tenant INSERT', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [businessA]);
      assert.deepEqual((await client.query('SELECT "Id" FROM "Suppliers" ORDER BY "Id"')).rows.map((r) => r.Id), [supplierA]);
      assert.equal((await client.query(`UPDATE "Suppliers" SET "Name" = 'stolen' WHERE "Id" = $1`, [supplierB])).rowCount, 0);
      assert.equal((await client.query(`DELETE FROM "Suppliers" WHERE "Id" = $1`, [supplierB])).rowCount, 0);
      await assert.rejects(
        client.query(`INSERT INTO "Suppliers" ("Id", "BusinessId", "Name") VALUES ($1, $2, 'wrong tenant')`, [randomUUID(), businessB]),
        (error) => error.code === '42501',
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('does not leak tenant context when the same connection is reused', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [businessA]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM "Suppliers"')).rows[0].n, 1);
    } finally {
      await client.query('ROLLBACK');
    }
    await client.query('BEGIN');
    try {
      assert.equal((await client.query('SELECT count(*)::int AS n FROM "Suppliers"')).rows[0].n, 0);
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [businessB]);
      assert.deepEqual((await client.query('SELECT "Id" FROM "Suppliers"')).rows.map((r) => r.Id), [supplierB]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
