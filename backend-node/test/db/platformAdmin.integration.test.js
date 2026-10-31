// Step 17b: platform administrator screens on real PostgreSQL through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: only an allowlisted account may call any of the platform routes; the admin of business A sees business B in the list and
// the right counts for B (never A's rows added in); a user's memberships across businesses are found; failed jobs of another
// business are listed and retried (the retry writes inside that business's own context); migration 0043's policy is SELECT only
// and switched on only by the platform-admin setting; the audit list and the health report work; views leave audit entries
// that never hold the searched address. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { runWithPlatformAdminRead } from '../../src/db/tenantRlsContext.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const BASE = '/api/platform-admin';

describe('platform admin screens on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let admin; let other; let plain; let membershipB;
  const adminEmail = `root-${randomBytes(4).toString('hex')}@example.test`;
  const get = (who, path) => api.call('GET', `${BASE}${path}`, { token: who.token });
  const addCustomer = async (who, name) => {
    const r = await api.call('POST', '/api/customers', { token: who.token, body: { fullName: name, email: `${randomBytes(3).toString('hex')}@example.test`, phone: `+234801${(randomBytes(4).readUInt32BE(0) % 10000000).toString().padStart(7, '0')}` } });
    assert.equal(r.status, 201, r.text);
  };
  async function seedNotification(businessId, status) {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO "NotificationOutbox" ("Id","BusinessId","RecipientMembershipId","Category","EventType","Title","Body","DeduplicationKey","InAppEnabled","Status","Attempts","NextAttemptUtc","LastError","CreatedAtUtc")
      VALUES ($1,$2,$3,'tasks','task.assigned','Task assigned','You have a task.',$4,TRUE,$5,5, now() + interval '1 day','provider said no', now())`,
    [id, businessId, membershipB, `dedupe-${id}`, status]);
    return id;
  }
  const rowOf = async (id) => (await db.pool.query('SELECT "Status","Attempts","BusinessId" FROM "NotificationOutbox" WHERE "Id" = $1', [id])).rows[0];

  before(async () => {
    db = await createTempDatabase(url, 'avzar_platform_admin');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool, { PLATFORM_ADMIN_EMAILS: adminEmail });
    admin = await signUp(api, 'rootshop', { email: adminEmail });
    other = await signUp(api, 'othershop');
    plain = other; // a signed-in owner who is not on the allowlist
    membershipB = (await db.pool.query(`SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "IsOwner" = TRUE`, [other.businessId])).rows[0].Id;
    await addCustomer(admin, 'A customer one');
    await addCustomer(other, 'B customer one');
    await addCustomer(other, 'B customer two');
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('the application role really is restricted, and the 0043 policy is SELECT only on the five queue tables', async () => {
    const { rows } = await db.pool.query(`SELECT tablename, cmd FROM pg_policies WHERE policyname = 'avzar_platform_admin_read' ORDER BY tablename`);
    assert.deepEqual(rows.map((r) => r.tablename), ['AppointmentReminders', 'EmailOutbox', 'NotificationOutbox', 'PushDeliveries', 'WorkerSummaryJobs']);
    assert.ok(rows.every((r) => r.cmd === 'SELECT'));
    const others = (await db.pool.query(`SELECT count(*)::int AS n FROM pg_policies WHERE policyname <> 'avzar_business_isolation'`)).rows[0].n;
    assert.ok(others >= 20, `the earlier lookup policies plus the five platform-admin read policies (found ${others})`);
  });

  it('refuses a signed-in non-admin and an anonymous caller on every platform route', async () => {
    for (const path of ['/businesses', `/businesses/${other.businessId}`, '/users?email=a@b.test', '/audit-logs', '/health', '/background-jobs']) {
      const r = await get(plain, path);
      assert.equal(r.status, 403, `${path}: ${r.text}`);
      assert.equal(r.body.code, 'platform_admin_required');
      assert.equal((await api.call('GET', `${BASE}${path}`)).status, 401, `${path} anonymous`);
    }
  });

  it('the admin of business A sees business B in the list; search and paging work', async () => {
    const all = await get(admin, '/businesses?limit=100');
    assert.equal(all.status, 200, all.text);
    const ids = all.body.items.map((b) => b.id);
    assert.ok(ids.includes(admin.businessId) && ids.includes(other.businessId));
    assert.equal(all.body.next, null);
    const found = await get(admin, '/businesses?q=otherShop');
    assert.deepEqual(found.body.items.map((b) => b.id), [other.businessId]);
    const first = await get(admin, '/businesses?limit=1');
    assert.equal(first.body.items.length, 1);
    assert.ok(first.body.next);
    const second = await get(admin, `/businesses?limit=1&before=${encodeURIComponent(first.body.next)}`);
    assert.equal(second.body.items.length, 1);
    assert.notEqual(second.body.items[0].id, first.body.items[0].id);
    assert.equal((await get(admin, '/businesses?before=garbage')).status, 400);
  });

  it('business B detail shows B counts only, owner and plan, and no customer names', async () => {
    const r = await get(admin, `/businesses/${other.businessId}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.usage.customers, 2, "A's customer is not counted in B");
    assert.equal(r.body.usage.activeStaff, 1);
    assert.equal(r.body.owner.email, other.email);
    assert.equal(r.body.plan.code, 'free');
    assert.doesNotMatch(r.text, /customer one|customer two/i);
    const mine = await get(admin, `/businesses/${admin.businessId}`);
    assert.equal(mine.body.usage.customers, 1);
    assert.equal((await get(admin, `/businesses/${randomUUID()}`)).status, 404);
    assert.equal((await get(admin, '/businesses/not-an-id')).status, 404);
  });

  it('a user lookup finds memberships in more than one business', async () => {
    const adminUserId = (await db.pool.query('SELECT "Id" FROM "AspNetUsers" WHERE "Email" = $1', [adminEmail])).rows[0].Id;
    await db.pool.query(`INSERT INTO "Memberships" ("Id","BusinessId","CreatedAtUtc","DisplayName","IsOwner","Status","UserId") VALUES ($1,$2,now(),'Guest in B',FALSE,0,$3)`, [randomUUID(), other.businessId, adminUserId]);
    const r = await get(admin, `/users?email=${encodeURIComponent(adminEmail.toUpperCase())}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.memberships.map((m) => m.businessId).sort(), [admin.businessId, other.businessId].sort());
    assert.equal(r.body.memberships.find((m) => m.businessId === admin.businessId).isOwner, true);
    assert.doesNotMatch(r.text, /PasswordHash|SecurityStamp|\$argon|phone/i);
    assert.equal((await get(admin, '/users?email=nobody-here@example.test')).status, 404);
    assert.equal((await get(admin, '/users?email=not-an-email')).status, 400);
  });

  it('the failed-jobs list shows another business\'s failed job (the gap 17b closes)', async () => {
    const id = await seedNotification(other.businessId, 'Failed');
    const r = await get(admin, '/background-jobs?limit=250&status=Failed');
    assert.equal(r.status, 200, r.text);
    const job = r.body.items.find((j) => j.id === id);
    assert.ok(job, 'a failed job of business B is listed for the platform admin');
    assert.equal(job.businessId, other.businessId);
  });

  it('retrying B\'s failed job works, writes in B\'s context, and is audited once; a sent job is refused', async () => {
    const id = await seedNotification(other.businessId, 'Failed');
    const r = await api.call('POST', `${BASE}/background-jobs/${id}/retry`, { token: admin.token, body: { kind: 'notification' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(await rowOf(id), { Status: 'Pending', Attempts: 0, BusinessId: other.businessId });
    const audit = (await db.pool.query(`SELECT "ActorEmail","DetailsJson" FROM "PlatformAuditLogs" WHERE "EntityId" = $1`, [`notification:${id}`])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].DetailsJson.businessId, other.businessId);
    const sent = await seedNotification(other.businessId, 'Sent');
    const refused = await api.call('POST', `${BASE}/background-jobs/${sent}/retry`, { token: admin.token, body: { kind: 'notification' } });
    assert.equal(refused.status, 409, refused.text);
    const unknown = await api.call('POST', `${BASE}/background-jobs/${randomUUID()}/retry`, { token: admin.token, body: { kind: 'notification' } });
    assert.equal(unknown.status, 404, unknown.text);
    const denied = await api.call('POST', `${BASE}/background-jobs/${id}/retry`, { token: plain.token, body: { kind: 'notification' } });
    assert.equal(denied.status, 403, denied.text);
  });

  it('the platform-admin setting reads across businesses but cannot write; without it nothing is visible', async () => {
    const id = await seedNotification(other.businessId, 'Failed');
    assert.equal((await role.pool.query('SELECT count(*)::int AS n FROM "NotificationOutbox"')).rows[0].n, 0, 'no context reads nothing');
    await runWithPlatformAdminRead(async () => {
      const seen = (await role.pool.query('SELECT "Id" FROM "NotificationOutbox" WHERE "Id" = $1', [id])).rows;
      assert.equal(seen.length, 1, 'visible under the platform-admin read setting');
      let changed = 0;
      try { changed = (await role.pool.query(`UPDATE "NotificationOutbox" SET "Status" = 'Sent' WHERE "Id" = $1`, [id])).rowCount; } catch { changed = 0; }
      assert.equal(changed, 0, 'the read policy gives no write access');
    });
    assert.equal((await rowOf(id)).Status, 'Failed');
    const customers = await runWithPlatformAdminRead(async () => (await role.pool.query('SELECT count(*)::int AS n FROM "Customers"')).rows[0].n);
    assert.equal(customers, 0, 'the setting opens the queue tables only, not customers');
  });

  it('views are audited without the searched address, and the audit list filters and pages', async () => {
    const all = await get(admin, '/audit-logs?limit=100');
    assert.equal(all.status, 200, all.text);
    const viewed = all.body.items.filter((e) => e.action === 'platform.business.viewed');
    assert.ok(viewed.length >= 2);
    const lookups = all.body.items.filter((e) => e.action === 'platform.user.lookup');
    assert.ok(lookups.length >= 2);
    // The actor column holds the admin's own address; what the lookup searched for must not be anywhere else in the entry.
    assert.doesNotMatch(JSON.stringify(lookups.map((e) => [e.details, e.entityId, e.entityType])), /example\.test|nobody-here/i);
    const filtered = await get(admin, '/audit-logs?action=platform.business.viewed&limit=1');
    assert.equal(filtered.body.items.length, 1);
    assert.ok(filtered.body.next);
    assert.ok(filtered.body.items.every((e) => e.action === 'platform.business.viewed'));
    assert.equal((await get(admin, '/audit-logs?from=yesterday')).status, 400);
  });

  it('the health report shows database, migrations, queue depth across businesses and which settings are present', async () => {
    const r = await get(admin, '/health');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.database.ok, true);
    assert.ok(r.body.migrations.applied >= 43);
    assert.match(r.body.migrations.latest, /^00\d\d_/);
    const notification = r.body.queues.find((q) => q.kind === 'notification');
    assert.ok(notification.statuses.Failed >= 1 || notification.statuses.Pending >= 1, 'queue rows of other businesses are counted');
    assert.ok(Array.isArray(r.body.configuration) && r.body.configuration.every((c) => typeof c.set === 'boolean'));
    assert.doesNotMatch(r.text, /JWT_SIGNING_KEY|integration-signing-key/);
  });
});
