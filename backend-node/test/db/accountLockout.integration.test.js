// Step-17a: the shared lockout rule against real PostgreSQL as a NOSUPERUSER, NOBYPASSRLS role: five wrong attempts lock the
// account on the sign-in route and on the routes that re-check a password; a count left over from an ended lockout restarts
// at 1; a deleted account's 'infinity' marker is never overwritten. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { recordFailedAttempt } from '../../src/security/accountLockout.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { PASSWORD, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('account lockout under a restricted role', { skip: !url }, () => {
  let db; let role; let api;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_lockout');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop?.(); });

  const userRow = async (email) => (await db.pool.query(`SELECT "Id","AccessFailedCount","LockoutEnd" FROM "AspNetUsers" WHERE "NormalizedEmail" = $1`, [email.toUpperCase()])).rows[0];
  const wrongChange = (token) => api.call('POST', '/api/account/change-password', { token, body: { currentPassword: 'definitely wrong password', newPassword: 'another long password 123' } });

  it('locks on the fifth wrong password on a route that re-checks the password, and then refuses sign-in and the right password', async () => {
    const owner = await signUp(api, 'LockA');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await wrongChange(owner.token);
      assert.equal(response.status, 400, `attempt ${attempt}: ${response.text}`);
      assert.equal(response.body.code, 'wrong_password');
    }
    const fifth = await wrongChange(owner.token);
    assert.equal(fifth.status, 423, fifth.text);
    assert.equal(fifth.body.code, 'locked_out');
    const row = await userRow(owner.email);
    assert.equal(row.AccessFailedCount, 5);
    assert.ok(new Date(row.LockoutEnd).getTime() > Date.now());

    const right = await api.call('POST', '/api/account/change-password', { token: owner.token, body: { currentPassword: PASSWORD, newPassword: 'another long password 123' } });
    assert.equal(right.status, 423, right.text);
    const login = await api.call('POST', '/api/auth/token', { body: { email: owner.email, password: PASSWORD, deviceName: 'integration' } });
    assert.equal(login.status, 423, login.text);
  });

  it('restarts the count at 1 after a lockout has ended, and a correct sign-in then clears it', async () => {
    const owner = await signUp(api, 'LockB');
    const { Id } = await userRow(owner.email);
    await db.pool.query(`UPDATE "AspNetUsers" SET "AccessFailedCount" = 5, "LockoutEnd" = now() - interval '1 minute' WHERE "Id" = $1`, [Id]);
    const wrong = await wrongChange(owner.token);
    assert.equal(wrong.status, 400, wrong.text);
    const after = await userRow(owner.email);
    assert.equal(after.AccessFailedCount, 1);
    assert.equal(after.LockoutEnd, null);
    const login = await api.call('POST', '/api/auth/token', { body: { email: owner.email, password: PASSWORD, deviceName: 'integration' } });
    assert.equal(login.status, 200, login.text);
    assert.equal((await userRow(owner.email)).AccessFailedCount, 0);
  });

  it('never overwrites the deleted-account marker', async () => {
    const owner = await signUp(api, 'LockC');
    const { Id } = await userRow(owner.email);
    await db.pool.query(`UPDATE "AspNetUsers" SET "AccessFailedCount" = 4, "LockoutEnabled" = TRUE, "LockoutEnd" = 'infinity' WHERE "Id" = $1`, [Id]);
    await assert.rejects(recordFailedAttempt(role.pool, Id), (error) => error.status === 423);
    const row = (await db.pool.query(`SELECT "LockoutEnd"::text AS "LockoutEnd" FROM "AspNetUsers" WHERE "Id" = $1`, [Id])).rows[0];
    assert.equal(row.LockoutEnd, 'infinity');
  });
});
