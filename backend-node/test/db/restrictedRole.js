// Step-09c: an application-like database role for the HTTP and worker suites. The role is NOSUPERUSER and NOBYPASSRLS, so row-level
// security applies to it exactly as it does to `avzar_user` on staging. The pool is wrapped the way src/server.js wraps the real pool
// (installTenantRlsContext); createApp() does not do that itself. Fixtures and assertions keep using the superuser `db.pool`.
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { installTenantRlsContext } from '../../src/db/tenantRlsContext.js';

/** Creates the role and a wrapped pool for `db` (a createTempDatabase result with migrations already applied). */
export async function createRestrictedAppPool(db, { max = 6 } = {}) {
  const roleName = `avzar_app_${randomBytes(5).toString('hex')}`;
  await db.pool.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await db.pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  await db.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
  await db.pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${roleName}"`);
  const u = new URL(db.url);
  u.username = roleName;
  u.password = 'pw';
  const pool = installTenantRlsContext(new pg.Pool({ connectionString: u.toString(), max }));
  return {
    roleName,
    pool,
    async close() {
      await pool.end().catch(() => {});
      await db.pool.query(`DROP OWNED BY "${roleName}"`).catch(() => {});
      await db.pool.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => {});
    },
  };
}

/** Fails the suite if the pool is not really a restricted role, so a setup slip cannot turn these tests into superuser tests. */
export async function assertRestrictedRole(pool) {
  const { rows } = await pool.query('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.equal(rows[0].rolsuper, false, `${rows[0].rolname} must not be a superuser`);
  assert.equal(rows[0].rolbypassrls, false, `${rows[0].rolname} must not bypass row-level security`);
}
