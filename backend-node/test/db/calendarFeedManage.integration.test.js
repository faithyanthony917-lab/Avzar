// Step-08a leftover: the calendar-link manager routes (make, list, stop) over HTTP on real PostgreSQL, through a NOSUPERUSER, NOBYPASSRLS role.
// Checks the location scope on every route (a manager limited to one location cannot make, list or stop a link for a worker elsewhere),
// that stopping does not depend on the worker still being active, that make and stop each write one audit entry (never the link), and
// that a stop that matches nothing writes no audit entry. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, firstLocationId, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('calendar-link manager routes on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let manager; let workerOne; let workerTwo; let locOne; let locTwo; let membershipOne; let membershipTwo;

  const membershipOf = async (email) => (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE m."BusinessId" = $1 AND u."Email" = $2`, [owner.businessId, email])).rows[0].Id;
  const assign = (membershipId, locationId) => db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`, [membershipId, locationId, owner.businessId]);
  const makeFeed = (who, membershipId) => api.call('POST', `/api/workers/${membershipId}/schedule/calendar-feed`, { token: who.token });
  const listFeeds = (who, membershipId) => api.call('GET', `/api/workers/${membershipId}/schedule/calendar-feeds`, { token: who.token });
  const stopFeed = (who, membershipId, feedId) => api.call('DELETE', `/api/workers/${membershipId}/schedule/calendar-feed/${feedId}`, { token: who.token });
  const count = async (sql, params) => Number((await db.pool.query(sql, params)).rows[0].n);
  const audits = (action, feedId) => count(`SELECT count(*) AS n FROM "AuditLogs" WHERE "Action" = $1 AND "EntityId" = $2`, [action, feedId]);
  const feedsOf = (membershipId) => count(`SELECT count(*) AS n FROM "CalendarFeedTokens" WHERE "MembershipId" = $1`, [membershipId]);
  const revokedAt = async (feedId) => (await db.pool.query(`SELECT "RevokedAtUtc" FROM "CalendarFeedTokens" WHERE "Id" = $1`, [feedId])).rows[0].RevokedAtUtc;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_cal_manage');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'cm-owner');
    other = await signUp(api, 'cm-other');
    // The Starter plan allows 3 accounts; this suite needs the owner, a manager and two workers, so lift only that one limit.
    await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
      VALUES ($1,$2,now(),'users.max','test fixture: more staff than the plan allows','unlimited')`, [randomUUID(), owner.businessId]);
    manager = await addStaff(api, db, owner, 'cm-manager', ['tasks.view']);
    workerOne = await addStaff(api, db, owner, 'cm-worker-one', ['tasks.work']);
    workerTwo = await addStaff(api, db, owner, 'cm-worker-two', ['tasks.work']);
    locOne = await firstLocationId(db, owner.businessId);
    locTwo = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Second shop',true,now())`, [locTwo, owner.businessId]);
    membershipOne = await membershipOf(workerOne.email);
    membershipTwo = await membershipOf(workerTwo.email);
    await assign(await membershipOf(manager.email), locOne);
    await assign(membershipOne, locOne);
    await assign(membershipTwo, locTwo);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  let ownerFeedOne; let ownerFeedTwo;
  it('the owner makes a link for each worker and each make writes one audit entry that never holds the link', async () => {
    const one = await makeFeed(owner, membershipOne);
    assert.equal(one.status, 201, one.text);
    ownerFeedOne = one.body;
    assert.equal(await audits('calendar_feed.created', one.body.id), 1);
    const row = (await db.pool.query(`SELECT "DetailsJson"::text AS details, "EntityType", "ActorUserId" FROM "AuditLogs" WHERE "Action" = 'calendar_feed.created' AND "EntityId" = $1`, [one.body.id])).rows[0];
    assert.equal(row.EntityType, 'CalendarFeed');
    assert.ok(row.details.includes(membershipOne));
    assert.ok(!row.details.includes(one.body.token), 'the link must not be written to the audit entry');
    const two = await makeFeed(owner, membershipTwo);
    assert.equal(two.status, 201, two.text);
    ownerFeedTwo = two.body;
  });

  it('a manager limited to one location cannot make or list a link for a worker at another', async () => {
    const before0 = await feedsOf(membershipTwo);
    const made = await makeFeed(manager, membershipTwo);
    assert.equal(made.status, 404, made.text);
    assert.equal(made.body.code, 'worker_not_found');
    assert.equal(await feedsOf(membershipTwo), before0);
    assert.equal((await listFeeds(manager, membershipTwo)).status, 404);
  });

  it('a manager limited to one location cannot stop a link that reaches only another location', async () => {
    const response = await stopFeed(manager, membershipTwo, ownerFeedTwo.id);
    assert.equal(response.status, 404, response.text);
    assert.equal(response.body.code, 'calendar_feed_not_found');
    assert.equal(await revokedAt(ownerFeedTwo.id), null);
    assert.equal(await audits('calendar_feed.revoked', ownerFeedTwo.id), 0);
    assert.equal((await api.call('GET', ownerFeedTwo.urlPath)).status, 200, 'the link still works');
  });

  it('a feed ID under the wrong worker is a 404 and changes nothing', async () => {
    const response = await stopFeed(owner, membershipOne, ownerFeedTwo.id);
    assert.equal(response.status, 404, response.text);
    assert.equal(await revokedAt(ownerFeedTwo.id), null);
    assert.equal(await audits('calendar_feed.revoked', ownerFeedTwo.id), 0);
  });

  it('another business cannot stop the link and nothing is written', async () => {
    const response = await stopFeed(other, membershipOne, ownerFeedOne.id);
    assert.ok([403, 404].includes(response.status), `got ${response.status}`);
    assert.equal(await revokedAt(ownerFeedOne.id), null);
    assert.equal(await audits('calendar_feed.revoked', ownerFeedOne.id), 0);
  });

  it('a manager makes and stops a link for a worker at their own location, once, with one audit entry each', async () => {
    const made = await makeFeed(manager, membershipOne);
    assert.equal(made.status, 201, made.text);
    assert.equal(await audits('calendar_feed.created', made.body.id), 1);
    assert.equal((await listFeeds(manager, membershipOne)).status, 200);
    assert.equal((await stopFeed(manager, membershipOne, made.body.id)).status, 204);
    assert.ok(await revokedAt(made.body.id));
    assert.equal(await audits('calendar_feed.revoked', made.body.id), 1);
    assert.equal((await api.call('GET', made.body.urlPath)).status, 404);
    const again = await stopFeed(manager, membershipOne, made.body.id);
    assert.equal(again.status, 404, again.text);
    assert.equal(await audits('calendar_feed.revoked', made.body.id), 1, 'a second stop writes no second entry');
  });

  it('a link can still be stopped after its worker was deactivated, and making one for them is refused', async () => {
    await db.pool.query(`UPDATE "Memberships" SET "Status" = 1 WHERE "Id" = $1`, [membershipOne]);
    assert.equal((await makeFeed(owner, membershipOne)).status, 404);
    assert.equal((await stopFeed(owner, membershipOne, ownerFeedOne.id)).status, 204);
    assert.equal(await audits('calendar_feed.revoked', ownerFeedOne.id), 1);
    assert.equal((await api.call('GET', ownerFeedOne.urlPath)).status, 404);
  });
});
