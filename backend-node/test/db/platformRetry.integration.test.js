// The platform-admin background-job routes over HTTP against real PostgreSQL: listing failed jobs and retrying them.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { signUp, startApp } from './httpHarness.js';

const url = process.env.DATABASE_URL;

describe('platform background-job retry (HTTP on PostgreSQL)', { skip: !url }, () => {
  let db; let api; let admin; let regular; let membershipId;
  const adminEmail = `ops-${randomBytes(4).toString('hex')}@example.test`;

  async function seedNotification(status) {
    const id = randomUUID();
    await db.pool.query(`
      INSERT INTO "NotificationOutbox" ("Id","BusinessId","RecipientMembershipId","Category","EventType","Title","Body","DeduplicationKey","InAppEnabled","Status","Attempts","NextAttemptUtc","LastError","CreatedAtUtc")
      VALUES ($1,$2,$3,'tasks','task.assigned','Task assigned','You have a task.',$4,TRUE,$5,5, now() + interval '1 day','provider said no', now())`,
    [id, admin.businessId, membershipId, `dedupe-${id}`, status]);
    return id;
  }
  async function seedPush(outboxId) {
    const tokenId = randomUUID();
    await db.pool.query(`INSERT INTO "PushTokens" ("Id","MembershipId","BusinessId","Token","Platform","Active","CreatedAtUtc","UpdatedAtUtc") VALUES ($1,$2,$3,$4,'ios',TRUE,now(),now())`,
      [tokenId, membershipId, admin.businessId, `ExponentPushToken[${randomBytes(8).toString('hex')}]`]);
    const id = randomUUID();
    await db.pool.query(`
      INSERT INTO "PushDeliveries" ("Id","BusinessId","OutboxId","RecipientMembershipId","PushTokenId","Status","Attempts","NextAttemptUtc","ErrorCode","CreatedAtUtc","UpdatedAtUtc")
      VALUES ($1,$2,$3,$4,$5,'Failed',3, now() + interval '1 day','DeviceNotRegistered', now(), now())`,
    [id, admin.businessId, outboxId, membershipId, tokenId]);
    return id;
  }
  const retry = (token, id, body) => api.call('POST', `/api/platform-admin/background-jobs/${id}/retry`, { token, body });
  const notification = async (id) => (await db.pool.query('SELECT "Status","Attempts","LastError" FROM "NotificationOutbox" WHERE "Id" = $1', [id])).rows[0];

  before(async () => {
    db = await createTempDatabase(url, 'avzar_platform_retry');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool, { PLATFORM_ADMIN_EMAILS: adminEmail });
    admin = await signUp(api, 'ops', { email: adminEmail });
    regular = await signUp(api, 'plain');
    membershipId = (await db.pool.query(`SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "IsOwner" = TRUE`, [admin.businessId])).rows[0].Id;
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('lists failed notification and push jobs for a platform admin', async () => {
    const outboxId = await seedNotification('Failed');
    const pushId = await seedPush(outboxId);
    const response = await api.call('GET', '/api/platform-admin/background-jobs?limit=250&status=Failed', { token: admin.token });
    assert.equal(response.status, 200, response.text);
    const found = (kind, id) => response.body.items.find((job) => job.kind === kind && job.id === id);
    assert.equal(found('notification', outboxId)?.status, 'Failed');
    assert.equal(found('push', pushId)?.status, 'Failed');
  });

  it('retries a failed notification: back to Pending with attempts reset, and one platform audit entry', async () => {
    const id = await seedNotification('Failed');
    const response = await retry(admin.token, id, { kind: 'notification' });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body, { id, kind: 'notification', status: 'Pending' });
    assert.deepEqual(await notification(id), { Status: 'Pending', Attempts: 0, LastError: null });
    const audit = await db.pool.query(`SELECT "ActorEmail","Action" FROM "PlatformAuditLogs" WHERE "EntityId" = $1`, [`notification:${id}`]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].Action, 'platform.notification.retry');
    assert.equal(audit.rows[0].ActorEmail, adminEmail.toLowerCase());
  });

  it('retries a failed push delivery and clears its error', async () => {
    const pushId = await seedPush(await seedNotification('Sent'));
    const response = await retry(admin.token, pushId, { kind: 'push' });
    assert.equal(response.status, 200, response.text);
    const delivery = (await db.pool.query('SELECT "Status","Attempts","ErrorCode" FROM "PushDeliveries" WHERE "Id" = $1', [pushId])).rows[0];
    assert.deepEqual(delivery, { Status: 'Pending', Attempts: 0, ErrorCode: null });
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "PlatformAuditLogs" WHERE "EntityId" = $1`, [`push:${pushId}`])).rows[0].n, 1);
  });

  it('refuses to retry a job that is not failed, and a second retry of the same job', async () => {
    const sent = await seedNotification('Sent');
    const refused = await retry(admin.token, sent, { kind: 'notification' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.code, 'job_not_failed');
    assert.equal((await notification(sent)).Status, 'Sent');
    const failed = await seedNotification('Failed');
    assert.equal((await retry(admin.token, failed, { kind: 'notification' })).status, 200);
    const again = await retry(admin.token, failed, { kind: 'notification' });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.code, 'job_not_failed');
  });

  it('answers 404 for an unknown or malformed job ID and 400 for a kind that cannot be retried', async () => {
    const unknown = await retry(admin.token, randomUUID(), { kind: 'notification' });
    assert.equal(unknown.status, 404, unknown.text);
    assert.equal(unknown.body.code, 'job_not_found');
    const malformed = await retry(admin.token, 'not-a-job', { kind: 'notification' });
    assert.equal(malformed.status, 404, malformed.text);
    const failed = await seedNotification('Failed');
    const badKind = await retry(admin.token, failed, { kind: 'email' });
    assert.equal(badKind.status, 400, badKind.text);
    assert.equal((await notification(failed)).Status, 'Failed');
  });

  it('refuses everyone who is not a platform admin, and anonymous callers', async () => {
    const failed = await seedNotification('Failed');
    const list = await api.call('GET', '/api/platform-admin/background-jobs?status=Failed', { token: regular.token });
    assert.equal(list.status, 403, list.text);
    const attempt = await retry(regular.token, failed, { kind: 'notification' });
    assert.equal(attempt.status, 403, attempt.text);
    assert.equal((await notification(failed)).Status, 'Failed');
    const anonymousList = await api.call('GET', '/api/platform-admin/background-jobs');
    assert.equal(anonymousList.status, 401, anonymousList.text);
    const anonymousRetry = await retry(undefined, failed, { kind: 'notification' });
    assert.equal(anonymousRetry.status, 401, anonymousRetry.text);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "PlatformAuditLogs" WHERE "EntityId" = $1`, [`notification:${failed}`])).rows[0].n, 0);
  });
});
