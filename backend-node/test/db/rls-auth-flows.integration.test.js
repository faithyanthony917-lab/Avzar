// Login, register, refresh, reset, invitations, sessions and business switching against real PostgreSQL as a
// NOSUPERUSER, NOBYPASSRLS role. Each flow starts with no tenant and must find its own business through a verified key.
// Skipped unless DATABASE_URL is set (CI job "node-db"). The superuser pool (db.pool) is used only to arrange and to inspect.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { installTenantRlsContext, runWithTenantRlsContext, setTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import {
  acceptInvitation, createBrowserSession, listUserBusinesses, registerBusiness, switchBusiness,
} from '../../src/auth/coreAuthService.js';
import { authenticate, createMobileSession, revokeMobileSession, rotateMobileSession } from '../../src/auth/mobileAuthService.js';
import { listSessions, requestPasswordReset, resetPassword, revokeSessionById } from '../../src/auth/accountService.js';
import { accountTokenKey, issueAccountToken, PURPOSE_RESET_PASSWORD } from '../../src/security/accountTokens.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const env = {
  JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars',
  WEB_BASE_URL: 'https://app.example.test',
  REFRESH_IDLE_DAYS: 30,
  REFRESH_ABSOLUTE_DAYS: 90,
  MAX_SESSIONS_PER_USER: 10,
  EMAIL_THROTTLE_SECONDS: 0,
};
// app.js opens one context per request; each call below stands for one request.
const request = (fn) => runWithTenantRlsContext(fn);
const sha256Lower = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const code = (expected) => (error) => error?.code === expected;

describe('auth flows under a restricted role', { skip: !url }, () => {
  let db;
  let roleName;
  let appPool;
  let userId;
  let businessA;
  const businessB = randomUUID();
  const email = `owner-${randomBytes(3).toString('hex')}@example.test`;
  const password = 'first long password 1';

  const scalar = async (sql, values = []) => Object.values((await db.pool.query(sql, values)).rows[0] ?? {})[0];

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rls_auth');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    roleName = `avzar_auth_${randomBytes(5).toString('hex')}`;
    await db.pool.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await db.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
    const u = new URL(db.url);
    u.username = roleName;
    u.password = 'pw';
    appPool = installTenantRlsContext(new pg.Pool({ connectionString: u.toString(), max: 4 }));
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

  it('registering a business writes every tenant row and queues the verification mail with no business', async () => {
    const identity = await request(() => registerBusiness(appPool, {
      email, password, ownerName: 'Ada Owner', businessName: 'Auth Shop A', currencyCode: 'NGN', timeZoneId: 'UTC',
    }, env));
    userId = identity.userId;
    businessA = identity.businessId;
    assert.equal(await scalar('SELECT count(*)::int FROM "Memberships" WHERE "UserId" = $1 AND "BusinessId" = $2', [userId, businessA]), 1);
    assert.equal(await scalar('SELECT count(*)::int FROM "Workflows" WHERE "BusinessId" = $1', [businessA]), 1);
    assert.equal(await scalar('SELECT count(*)::int FROM "Subscriptions" WHERE "BusinessId" = $1', [businessA]), 1);
    assert.equal(await scalar(`SELECT count(*)::int FROM "EmailOutbox" WHERE "TemplateKey" = 'verify_email' AND "BusinessId" IS NULL AND "Status" = 'Pending'`), 1);
  });

  it('login finds the user\'s memberships once credentials are verified, and rejects bad credentials', async () => {
    const result = await request(() => authenticate(appPool, { email, password }, env));
    assert.equal(result.userId, userId);
    assert.equal(result.businessId, businessA);
    assert.equal(result.choices.length, 1);
    await assert.rejects(request(() => authenticate(appPool, { email, password: 'wrong password 123' }, env)), code('invalid_credentials'));
  });

  it('refresh rotates under the session\'s own business, reuse revokes it, and an unknown token is invalid', async () => {
    const tokens = await request(() => createMobileSession(appPool, userId, businessA, 'Phone', env));
    const rotated = await request(() => rotateMobileSession(appPool, tokens.refreshToken, env));
    assert.equal(rotated.businessId, businessA);
    assert.equal(rotated.userId, userId);
    await assert.rejects(request(() => rotateMobileSession(appPool, tokens.refreshToken, env)), code('token_reuse_detected'));
    assert.equal(await scalar('SELECT "RevokedReason" FROM "UserSessions" WHERE "Id" = $1', [tokens.sessionId]), 'token_reuse');
    await assert.rejects(request(() => rotateMobileSession(appPool, `${'a'.repeat(32)}.${'b'.repeat(30)}`, env)), code('invalid_refresh_token'));
  });

  it('revoke ends the session that holds the token', async () => {
    const tokens = await request(() => createMobileSession(appPool, userId, businessA, 'Phone', env));
    await request(() => revokeMobileSession(appPool, tokens.refreshToken));
    assert.notEqual(await scalar('SELECT "RevokedAtUtc" FROM "UserSessions" WHERE "Id" = $1', [tokens.sessionId]), null);
  });

  it('a user in two businesses: login offers both, sessions list from both, and one can be revoked by id', async () => {
    await db.pool.query(`INSERT INTO "Businesses" ("Id","CreatedAtUtc","CurrencyCode","IsActive","Name","TimeZoneId") VALUES ($1, now(), 'NGN', true, 'Auth Shop B', 'UTC')`, [businessB]);
    await db.pool.query(`INSERT INTO "Memberships" ("Id","BusinessId","UserId","DisplayName","IsOwner","Status","CreatedAtUtc") VALUES ($1,$2,$3,'Ada Owner',true,0,now())`, [randomUUID(), businessB, userId]);
    const choice = await request(() => authenticate(appPool, { email, password }, env));
    assert.equal(choice.businessId, null);
    assert.equal(choice.choices.length, 2);
    const picked = await request(() => authenticate(appPool, { email, password, businessId: businessB }, env));
    assert.equal(picked.businessId, businessB);
    assert.equal((await request(() => listUserBusinesses(appPool, userId, businessA))).length, 2);

    const sessionA = await request(() => createMobileSession(appPool, userId, businessA, 'Phone', env));
    const sessionB = await request(() => createMobileSession(appPool, userId, businessB, 'Tablet', env));
    const listed = await request(() => listSessions(appPool, userId));
    assert.deepEqual(listed.map((s) => s.id).sort(), [sessionA.sessionId, sessionB.sessionId].sort());

    await request(() => revokeSessionById(appPool, userId, sessionB.sessionId));
    assert.notEqual(await scalar('SELECT "RevokedAtUtc" FROM "UserSessions" WHERE "Id" = $1', [sessionB.sessionId]), null);
    assert.equal(await scalar('SELECT "RevokedAtUtc" FROM "UserSessions" WHERE "Id" = $1', [sessionA.sessionId]), null);
    await assert.rejects(request(() => revokeSessionById(appPool, userId, randomUUID())), code('session_not_found'));
  });

  it('a password reset mail is queued with no business, and the reset ends sessions in every business', async () => {
    await request(() => requestPasswordReset(appPool, env, email));
    assert.equal(await scalar(`SELECT count(*)::int FROM "EmailOutbox" WHERE "TemplateKey" = 'password_reset' AND "BusinessId" IS NULL`), 1);
    await request(() => requestPasswordReset(appPool, env, 'nobody@example.test'));
    assert.equal(await scalar(`SELECT count(*)::int FROM "EmailOutbox" WHERE "TemplateKey" = 'password_reset'`), 1, 'an unknown address queues nothing');

    await request(() => createMobileSession(appPool, userId, businessB, 'Tablet', env));
    assert.ok(await scalar('SELECT count(*)::int FROM "UserSessions" WHERE "UserId" = $1 AND "RevokedAtUtc" IS NULL AND "BusinessId" IN ($2, $3)', [userId, businessA, businessB]) >= 2);
    const user = (await db.pool.query('SELECT "Id","SecurityStamp","PasswordHash" FROM "AspNetUsers" WHERE "Id" = $1', [userId])).rows[0];
    const token = issueAccountToken(accountTokenKey(env), user, PURPOSE_RESET_PASSWORD, 600);
    const newPassword = 'second long password 2';
    await request(() => resetPassword(appPool, env, { userId, token, newPassword }));
    assert.equal(await scalar('SELECT count(*)::int FROM "UserSessions" WHERE "UserId" = $1 AND "RevokedAtUtc" IS NULL', [userId]), 0, 'sessions in both businesses are revoked');
    await assert.rejects(request(() => resetPassword(appPool, env, { userId, token, newPassword: 'third long password 3' })), code('invalid_token'));
    const again = await request(() => authenticate(appPool, { email, password: newPassword, businessId: businessA }, env));
    assert.equal(again.businessId, businessA);
  });

  it('accepting an invitation finds its business from the token alone', async () => {
    await db.pool.query(`UPDATE "Subscriptions" SET "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = 'starter') WHERE "BusinessId" = $1`, [businessA]);
    const roleId = await scalar(`SELECT "Id" FROM "BusinessRoles" WHERE "BusinessId" = $1 AND "Name" = 'Manager'`, [businessA]);
    const token = randomBytes(24).toString('base64url');
    await db.pool.query(`
      INSERT INTO "Invitations" ("Id","BusinessId","CreatedAtUtc","Email","ExpiresAtUtc","FullName","InvitedByUserId","TokenHash","RoleIds","LocationIds")
      VALUES ($1,$2,now(),'staff@example.test', now() + interval '1 day','Sam Staff',$3,$4, ARRAY[$5]::uuid[], '{}'::uuid[])`,
    [randomUUID(), businessA, userId, sha256Lower(token), roleId]);
    await assert.rejects(request(() => acceptInvitation(appPool, { token: 'not-a-real-token', password: 'staff long password 1' })), code('invalid_invitation'));
    const accepted = await request(() => acceptInvitation(appPool, { token, password: 'staff long password 1' }));
    assert.equal(accepted.businessId, businessA);
    assert.equal(await scalar('SELECT count(*)::int FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2', [businessA, accepted.userId]), 1);
    assert.notEqual(await scalar('SELECT "AcceptedAtUtc" FROM "Invitations" WHERE "TokenHash" = $1', [sha256Lower(token)]), null);
  });

  it('switching business creates the new session, revokes the old one and audits under the target business', async () => {
    const first = await request(() => createBrowserSession(appPool, env, { userId, businessId: businessA }));
    const switched = await request(async () => {
      setTenantRlsContext(businessA); // what requireBearerAuth does from the signed token
      return switchBusiness(appPool, env, { userId, businessId: businessA, sessionId: first.sessionId }, businessB);
    });
    assert.equal(switched.identity.businessId, businessB);
    assert.equal(switched.created.user.businessId, businessB);
    assert.equal(await scalar('SELECT "RevokedReason" FROM "UserSessions" WHERE "Id" = $1', [first.sessionId]), 'business_switch');
    assert.equal(await scalar('SELECT "BusinessId" FROM "UserSessions" WHERE "Id" = $1', [switched.created.sessionId]), businessB);
    assert.equal(await scalar(`SELECT count(*)::int FROM "AuditLogs" WHERE "Action" = 'auth.business_switched' AND "BusinessId" = $1`, [businessB]), 1);
    await assert.rejects(
      request(async () => { setTenantRlsContext(businessA); return switchBusiness(appPool, env, { userId, businessId: businessA, sessionId: randomUUID() }, randomUUID()); }),
      code('not_a_member'),
    );
  });

  it('nothing leaked: with no context the application role still sees no tenant rows', async () => {
    for (const table of ['Memberships', 'UserSessions', 'Invitations', 'AuditLogs']) {
      await request(async () => {
        assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n, 0, table);
      });
    }
  });
});
