// Publishing the shop schedule over HTTP against real PostgreSQL: the version row and the audit row are written
// together, a failed or stale publish writes neither, and another business cannot publish or see the audit entry.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { confirmedOrder, firstLocationId, signUp, startApp } from './httpHarness.js';

const url = process.env.DATABASE_URL;
const REASON = 'Publishing the plan after the Monday review';

describe('shop schedule publish audit over HTTP on PostgreSQL', { skip: !url }, () => {
  let db; let api; let owner; let other; let ownerUserId; let startUtc; let preview;

  const auditRows = async (businessId) => (await db.pool.query(
    `SELECT "ActorUserId","EntityType","EntityId","DetailsJson" FROM "AuditLogs" WHERE "BusinessId" = $1 AND "Action" = 'shop_schedule.published'`, [businessId])).rows;
  const versionRows = async (businessId) => (await db.pool.query(
    'SELECT "Id","VersionNumber","TaskCount" FROM "ShopScheduleVersions" WHERE "BusinessId" = $1', [businessId])).rows;
  const applyBody = (reason = REASON) => ({
    startUtc, horizonDays: 60, reason, expectedTaskVersions: preview.taskVersions,
    expectedSlots: preview.scheduled.map(({ taskId, startUtc: s, endUtc, version }) => ({ taskId, startUtc: s, endUtc, version })),
  });

  before(async () => {
    db = await createTempDatabase(url, 'avzar_schedule_audit');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    api = await startApp(db.pool);
    owner = await signUp(api, 'schedule-owner');
    other = await signUp(api, 'schedule-other');
    ownerUserId = (await db.pool.query('SELECT "Id" FROM "AspNetUsers" WHERE "Email" = $1', [owner.email])).rows[0].Id;
    // Move the owner to a plan that includes the shop-wide schedule.
    const plan = await db.pool.query(`SELECT p."Id" FROM "Plans" p JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" WHERE pe."Key" = 'scheduling.shop' AND pe."Value" = 'true' ORDER BY p."Code" LIMIT 1`);
    assert.ok(plan.rows.length, 'a seeded plan must include scheduling.shop');
    await db.pool.query('UPDATE "Subscriptions" SET "PlanId" = $2 WHERE "BusinessId" = $1', [owner.businessId, plan.rows[0].Id]);
    // The planner needs opening hours. Add Monday to Sunday 08:00-17:00 only if registration created none.
    const hours = await db.pool.query('SELECT count(*)::int AS n FROM "BusinessHours" WHERE "BusinessId" = $1', [owner.businessId]);
    if (hours.rows[0].n === 0) {
      for (let day = 0; day < 7; day += 1) {
        await db.pool.query(`INSERT INTO "BusinessHours" ("Id","BusinessId","DayOfWeek","IsOpen","OpensAt","ClosesAt","CreatedAtUtc") VALUES ($1,$2,$3,TRUE,'08:00','17:00',now())`, [randomUUID(), owner.businessId, day]);
      }
    }
    await confirmedOrder(api, db, owner, await firstLocationId(db, owner.businessId), 'schedule');
    // The planner skips tasks with no assigned worker ("Worker assignment is required.") or no duration estimate,
    // so give every open task the owner and a minimum estimate. The test is about publishing, not about assigning.
    const ownerMembership = (await db.pool.query(`SELECT membership.\"Id\" FROM \"Memberships\" membership
      JOIN \"AspNetUsers\" appUser ON appUser.\"Id\" = membership.\"UserId\"
      WHERE membership.\"BusinessId\" = $1 AND membership.\"Status\" = 0 AND appUser.\"Email\" = $2`, [owner.businessId, owner.email])).rows[0];
    assert.ok(ownerMembership, 'the owner must have an active membership');
    const assigned = await db.pool.query(`UPDATE \"ProductionTasks\" SET \"AssignedMembershipId\" = $2, \"EstimatedMinutes\" = COALESCE(\"EstimatedMinutes\", 30)
      WHERE \"BusinessId\" = $1 AND \"Status\" = 'Pending'`, [owner.businessId, ownerMembership.Id]);
    assert.ok(assigned.rowCount > 0, 'the confirmed order must have generated pending tasks');
    startUtc = new Date(Date.now() + 86_400_000).toISOString();
  });
  after(async () => { await api?.close(); await db?.drop(); });

  it('previews a plan that schedules every task', async () => {
    const response = await api.call('POST', '/api/tasks/schedule/preview', { token: owner.token, body: { startUtc, horizonDays: 60 } });
    assert.equal(response.status, 200, response.text);
    preview = response.body;
    assert.ok(preview.scheduled.length > 0, `nothing was scheduled: ${response.text.slice(0, 400)}`);
    assert.deepEqual(preview.unscheduled, [], `tasks could not be scheduled: ${JSON.stringify(preview.unscheduled).slice(0, 400)}`);
    assert.equal(Object.keys(preview.taskVersions).length, preview.scheduled.length);
  });

  it('a publish without a real reason is refused and writes nothing', async () => {
    const response = await api.call('POST', '/api/tasks/schedule/apply', { token: owner.token, body: applyBody('x') });
    assert.equal(response.status, 400, response.text);
    assert.equal((await versionRows(owner.businessId)).length, 0);
    assert.equal((await auditRows(owner.businessId)).length, 0);
  });

  it('another business cannot publish this business\'s plan, and nothing is written for either business', async () => {
    const response = await api.call('POST', '/api/tasks/schedule/apply', { token: other.token, body: applyBody() });
    assert.ok([403, 409].includes(response.status), `expected 403 or 409, got ${response.status}: ${response.text}`);
    assert.equal((await versionRows(other.businessId)).length, 0);
    assert.equal((await auditRows(other.businessId)).length, 0);
    assert.equal((await versionRows(owner.businessId)).length, 0);
    const planned = await db.pool.query('SELECT count(*)::int AS n FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "PlannedStartUtc" IS NOT NULL', [owner.businessId]);
    assert.equal(planned.rows[0].n, 0, 'the other business must not have scheduled any of this business\'s tasks');
  });

  it('publishing writes the version and exactly one audit row, attributed to the publisher', async () => {
    const response = await api.call('POST', '/api/tasks/schedule/apply', { token: owner.token, body: applyBody() });
    assert.equal(response.status, 200, response.text);
    const versions = await versionRows(owner.businessId);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].VersionNumber, 1);
    assert.equal(versions[0].TaskCount, preview.scheduled.length);
    const audit = await auditRows(owner.businessId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].ActorUserId, ownerUserId);
    assert.equal(audit[0].EntityType, 'ShopScheduleVersion');
    assert.equal(String(audit[0].EntityId), String(versions[0].Id));
    const details = typeof audit[0].DetailsJson === 'string' ? JSON.parse(audit[0].DetailsJson) : audit[0].DetailsJson;
    assert.equal(details.reason, REASON);
    assert.equal(details.versionNumber, 1);
    assert.equal(details.taskCount, preview.scheduled.length);
    assert.equal(details.horizonDays, 60);
  });

  it('the other business has no audit entry, and replaying the same plan is stale and adds none', async () => {
    assert.equal((await auditRows(other.businessId)).length, 0);
    const replay = await api.call('POST', '/api/tasks/schedule/apply', { token: owner.token, body: applyBody() });
    assert.equal(replay.status, 409, replay.text);
    assert.equal(replay.body.code, 'schedule_preview_stale');
    assert.equal((await auditRows(owner.businessId)).length, 1);
    assert.equal((await versionRows(owner.businessId)).length, 1);
  });
});
