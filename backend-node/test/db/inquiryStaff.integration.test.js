// Step-14b: the staff inquiry routes other than schedule (list, summary, get, update, convert) over HTTP on real PostgreSQL,
// run through a NOSUPERUSER, NOBYPASSRLS role like the staging database. Fixtures and row checks use the superuser pool.
// Checks: sign-in and the view and manage permissions, another business's requests never show and never change (404, nothing written),
// filters and paging, the audit entries of update and convert, convert in one transaction (a refused location leaves no customer,
// order or audit row), a repeat is refused, and a user limited to one location cannot convert into another.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, firstLocationId, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe('staff inquiry routes on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let noPerm; let viewOnly; let limited; let locationId; let locationTwo; let ownerSf; let otherSf; let ownerUserId;

  const promised = () => new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10);
  const convertBody = (extra = {}) => ({ locationId, promisedDate: promised(), unitPrice: 15000, ...extra });
  const addStorefront = async (businessId) => {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO "Storefronts" ("Id","BusinessId","Slug","Name","Status","TemplateKey","DraftJson","DraftRevision","AllowSearchIndexing",
      "WorkflowBooking","WorkflowContact","WorkflowCustomOrder","WorkflowInquiry","CreatedAtUtc")
      VALUES ($1,$2,$3,'Shop','Draft','luxury','{}',1,false,true,true,true,true,now())`, [id, businessId, `ist-${randomUUID().slice(0, 8)}`]);
    return id;
  };
  const addInquiry = async ({ kind = 'Inquiry', status = 'New', email, name = 'Request Person', business = 'owner' } = {}) => {
    const id = randomUUID();
    const businessId = business === 'owner' ? owner.businessId : other.businessId;
    const storefrontId = business === 'owner' ? ownerSf : otherSf;
    await db.pool.query(`INSERT INTO "Inquiries" ("Id","BusinessId","StorefrontId","Kind","Status","Name","Email","Message","CreatedAtUtc")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'I would like a quote.', now())`, [id, businessId, storefrontId, kind, status, name, email]);
    return id;
  };
  const row = async (id) => (await db.pool.query(`SELECT "Status","InternalNote","ConvertedOrderId","HandledByUserId", xmin::text AS version FROM "Inquiries" WHERE "Id" = $1`, [id])).rows[0];
  const count = async (sql, params = []) => Number((await db.pool.query(sql, params)).rows[0].n);
  const auditCount = (action, entityId) => count(`SELECT count(*) AS n FROM "AuditLogs" WHERE "Action" = $1 AND "EntityId" = $2`, [action, entityId]);
  const customersWith = (businessId, email) => count(`SELECT count(*) AS n FROM "Customers" WHERE "BusinessId" = $1 AND "NormalizedEmail" = $2`, [businessId, email]);
  const orders = () => count(`SELECT count(*) AS n FROM "Orders"`);
  const list = (who, query = '') => api.call('GET', `/api/inquiries${query}`, { token: who?.token });
  const summary = (who) => api.call('GET', '/api/inquiries/summary', { token: who?.token });
  const get = (who, id) => api.call('GET', `/api/inquiries/${id}`, { token: who?.token });
  const update = (who, id, payload) => api.call('PUT', `/api/inquiries/${id}`, { token: who?.token, body: payload });
  const convert = (who, id, payload) => api.call('POST', `/api/inquiries/${id}/convert`, { token: who?.token, body: payload });

  before(async () => {
    db = await createTempDatabase(url, 'avzar_inq_staff');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'ist-owner');
    other = await signUp(api, 'ist-other');
    // The Starter plan allows 3 accounts; this suite needs the owner and four staff, so lift only that one limit.
    await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
      VALUES ($1,$2,now(),'users.max','test fixture: more staff than the plan allows','unlimited')`, [randomUUID(), owner.businessId]);
    noPerm = await addStaff(api, db, owner, 'ist-noperm', ['customers.view']);
    viewOnly = await addStaff(api, db, owner, 'ist-view', ['inquiries.view']);
    limited = await addStaff(api, db, owner, 'ist-limited', ['inquiries.view', 'inquiries.manage']);
    locationId = await firstLocationId(db, owner.businessId);
    locationTwo = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Second shop',true,now())`, [locationTwo, owner.businessId]);
    await db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId")
      SELECT m."Id", $3, $2 FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId" WHERE m."BusinessId" = $2 AND u."Email" = $1`, [limited.email, owner.businessId, locationId]);
    ownerUserId = (await db.pool.query(`SELECT "Id" FROM "AspNetUsers" WHERE "Email" = $1`, [owner.email])).rows[0].Id;
    ownerSf = await addStorefront(owner.businessId);
    otherSf = await addStorefront(other.businessId);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('needs a sign-in and the right permission on every route', async () => {
    const id = await addInquiry({ email: 'perm@example.test' });
    const before0 = await row(id);
    for (const response of [await list(null), await summary(null), await get(null, id)]) assert.equal(response.status, 401, response.text);
    for (const who of [noPerm]) {
      for (const response of [await list(who), await summary(who), await get(who, id),
        await update(who, id, { status: 'Reviewed' }), await convert(who, id, convertBody())]) assert.equal(response.status, 403, response.text);
    }
    for (const response of [await list(viewOnly), await summary(viewOnly), await get(viewOnly, id)]) assert.equal(response.status, 200, response.text);
    assert.equal((await update(viewOnly, id, { status: 'Reviewed' })).status, 403);
    assert.equal((await convert(viewOnly, id, convertBody())).status, 403);
    assert.deepEqual(await row(id), before0, 'refused calls change nothing');
    assert.equal(await customersWith(owner.businessId, 'perm@example.test'), 0);
  });

  it('list, summary and get show only the caller\'s own business', async () => {
    const own = await addInquiry({ email: 'list-own@example.test', name: 'Own Visitor' });
    const ownReviewed = await addInquiry({ kind: 'Appointment', status: 'Reviewed', email: 'list-rev@example.test', name: 'Reviewed Visitor' });
    const foreign = await addInquiry({ email: 'list-foreign@example.test', name: 'Foreign Visitor', business: 'other' });

    const all = await list(owner, '?pageSize=100');
    assert.equal(all.status, 200, all.text);
    const ids = all.body.items.map((item) => item.id);
    assert.ok(ids.includes(own) && ids.includes(ownReviewed));
    assert.ok(!ids.includes(foreign), 'another business\'s request never appears');
    assert.equal(all.body.totalCount, await count(`SELECT count(*) AS n FROM "Inquiries" WHERE "BusinessId" = $1`, [owner.businessId]));
    assert.equal((await list(owner, '?search=Foreign')).body.items.length, 0);
    assert.equal((await list(other, '?search=Foreign')).body.items.length, 1);

    const reviewed = await list(owner, '?status=Reviewed');
    assert.ok(reviewed.body.items.length >= 1 && reviewed.body.items.every((item) => item.status === 'Reviewed'));
    const bookings = await list(owner, '?kind=Appointment');
    assert.ok(bookings.body.items.some((item) => item.id === ownReviewed) && bookings.body.items.every((item) => item.kind === 'Appointment'));
    const paged = await list(owner, '?pageSize=1&page=1');
    assert.equal(paged.body.items.length, 1);
    assert.equal(paged.body.totalCount, all.body.totalCount);
    assert.equal((await list(owner, '?search=%25')).body.items.length, 0, 'a percent sign is searched for literally');
    assert.equal((await list(owner, '?status=Nonsense')).status, 400);
    const badPaging = await list(owner, '?pageSize=101');
    assert.equal(badPaging.status, 400, badPaging.text);
    assert.equal(badPaging.body.code, 'invalid_paging');

    const counts = (await db.pool.query(`SELECT "Status", count(*)::int AS n FROM "Inquiries" WHERE "BusinessId" = $1 GROUP BY "Status"`, [owner.businessId])).rows;
    const expected = { new: 0, reviewed: 0, converted: 0, rejected: 0 };
    for (const item of counts) expected[item.Status.toLowerCase()] = item.n;
    const total = await summary(owner);
    assert.equal(total.status, 200, total.text);
    assert.deepEqual(total.body, expected);

    const one = await get(owner, own);
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.id, own); assert.equal(one.body.email, 'list-own@example.test'); assert.equal(one.body.appointmentId, null);
    const crossGet = await get(owner, foreign);
    assert.equal(crossGet.status, 404, crossGet.text);
    assert.equal(crossGet.body.code, 'inquiry_not_found');
    assert.equal((await get(owner, 'not-a-uuid')).status, 404);
  });

  it('update: another business gets 404 and nothing changes; an own request is updated with one audit entry', async () => {
    const foreign = await addInquiry({ email: 'upd-foreign@example.test', business: 'other' });
    const foreignBefore = await row(foreign);
    const cross = await update(owner, foreign, { status: 'Reviewed', internalNote: 'should not land' });
    assert.equal(cross.status, 404, cross.text);
    assert.equal(cross.body.code, 'inquiry_not_found');
    assert.deepEqual(await row(foreign), foreignBefore);
    assert.equal(await auditCount('inquiry.updated', foreign), 0);
    assert.equal((await update(owner, 'not-a-uuid', { status: 'Reviewed' })).status, 404);

    const own = await addInquiry({ email: 'upd-own@example.test' });
    const done = await update(owner, own, { status: 'Reviewed', internalNote: 'Called the customer' });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.status, 'Reviewed'); assert.equal(done.body.internalNote, 'Called the customer');
    const stored = await row(own);
    assert.equal(stored.Status, 'Reviewed'); assert.equal(stored.HandledByUserId, ownerUserId);
    assert.equal(await auditCount('inquiry.updated', own), 1);

    const afterOk = await row(own);
    const toConverted = await update(owner, own, { status: 'Converted' });
    assert.equal(toConverted.status, 400, toConverted.text); assert.equal(toConverted.body.code, 'use_convert');
    assert.equal((await update(owner, own, { status: 'Nonsense' })).status, 400);
    const html = await update(owner, own, { status: 'Reviewed', internalNote: '<b>x</b>' });
    assert.equal(html.status, 400, html.text); assert.equal(html.body.code, 'invalid_text');
    assert.deepEqual(await row(own), afterOk, 'refused updates change nothing');
    assert.equal(await auditCount('inquiry.updated', own), 1, 'refused updates write no audit entry');

    const converted = await addInquiry({ status: 'Converted', email: 'upd-converted@example.test' });
    const locked = await update(owner, converted, { status: 'Rejected' });
    assert.equal(locked.status, 409, locked.text); assert.equal(locked.body.code, 'already_converted');
    assert.equal((await row(converted)).Status, 'Converted');
    assert.equal(await auditCount('inquiry.updated', converted), 0);
  });

  it('convert: another business gets 404, a bad body is 400, and nothing is written', async () => {
    const foreign = await addInquiry({ email: 'conv-foreign@example.test', business: 'other' });
    const foreignBefore = await row(foreign);
    const ordersBefore = await orders();
    const cross = await convert(owner, foreign, convertBody());
    assert.equal(cross.status, 404, cross.text); assert.equal(cross.body.code, 'inquiry_not_found');
    assert.deepEqual(await row(foreign), foreignBefore);
    assert.equal(await customersWith(other.businessId, 'conv-foreign@example.test'), 0);
    assert.equal(await customersWith(owner.businessId, 'conv-foreign@example.test'), 0);
    assert.equal(await auditCount('inquiry.converted', foreign), 0);
    assert.equal((await convert(owner, 'not-a-uuid', convertBody())).status, 404);

    const own = await addInquiry({ email: 'conv-body@example.test' });
    assert.equal((await convert(owner, own, { locationId, promisedDate: promised() })).status, 400, 'a missing price is refused');
    assert.equal((await convert(owner, own, convertBody({ promisedDate: '2026-02-30' }))).status, 400, 'an impossible date is refused');
    assert.equal(await orders(), ordersBefore);
    assert.equal(await customersWith(owner.businessId, 'conv-body@example.test'), 0);
    assert.equal((await row(own)).Status, 'New');
  });

  it('convert: a location of another business is refused and everything rolls back', async () => {
    const otherLocation = await firstLocationId(db, other.businessId);
    const id = await addInquiry({ email: 'conv-xloc@example.test' });
    const before0 = await row(id);
    const ordersBefore = await orders();
    const response = await convert(owner, id, convertBody({ locationId: otherLocation }));
    assert.equal(response.status, 400, response.text); assert.equal(response.body.code, 'unknown_location');
    assert.deepEqual(await row(id), before0);
    assert.equal(await customersWith(owner.businessId, 'conv-xloc@example.test'), 0, 'the new customer is rolled back');
    assert.equal(await orders(), ordersBefore);
    assert.equal(await auditCount('inquiry.converted', id), 0);
  });

  it('convert: one transaction creates customer and order, links the request and writes one audit entry; a repeat is 409', async () => {
    const id = await addInquiry({ email: 'Conv.Own@Example.test' });
    const ordersBefore = await orders();
    const done = await convert(owner, id, convertBody({ garmentName: 'Kaftan' }));
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.status, 'Converted');
    assert.ok(done.body.convertedOrderId);
    const stored = await row(id);
    assert.equal(stored.Status, 'Converted'); assert.equal(stored.ConvertedOrderId, done.body.convertedOrderId); assert.equal(stored.HandledByUserId, ownerUserId);
    assert.equal(await customersWith(owner.businessId, 'conv.own@example.test'), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM "Orders" WHERE "Id" = $1 AND "BusinessId" = $2 AND "LocationId" = $3`, [stored.ConvertedOrderId, owner.businessId, locationId]), 1);
    assert.equal(await orders(), ordersBefore + 1);
    assert.equal(await auditCount('inquiry.converted', id), 1);

    const again = await convert(owner, id, convertBody());
    assert.equal(again.status, 409, again.text); assert.equal(again.body.code, 'not_convertible');
    assert.equal(await orders(), ordersBefore + 1, 'a repeat creates no second order');
    assert.equal(await auditCount('inquiry.converted', id), 1);

    const rejected = await addInquiry({ status: 'Rejected', email: 'conv-rejected@example.test' });
    const refused = await convert(owner, rejected, convertBody());
    assert.equal(refused.status, 409, refused.text); assert.equal(refused.body.code, 'not_convertible');
    assert.equal(await customersWith(owner.businessId, 'conv-rejected@example.test'), 0);
    assert.equal(await orders(), ordersBefore + 1);
  });

  it('convert: a user limited to one location cannot convert into another, and can at their own', async () => {
    const id = await addInquiry({ email: 'conv-limited@example.test' });
    const before0 = await row(id);
    const ordersBefore = await orders();
    const refused = await convert(limited, id, convertBody({ locationId: locationTwo }));
    assert.equal(refused.status, 403, refused.text); assert.equal(refused.body.code, 'location_forbidden');
    assert.deepEqual(await row(id), before0);
    assert.equal(await customersWith(owner.businessId, 'conv-limited@example.test'), 0, 'the new customer is rolled back');
    assert.equal(await orders(), ordersBefore);
    assert.equal(await auditCount('inquiry.converted', id), 0);

    const allowed = await convert(limited, id, convertBody());
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal(await orders(), ordersBefore + 1);
    assert.equal(await auditCount('inquiry.converted', id), 1);
  });

  it('requests are business-wide: a location-limited user sees the same list as the owner', async () => {
    // Inquiries carry no location column, so there is nothing to filter by. This test records that behaviour on purpose.
    const ownerList = await list(owner, '?pageSize=100');
    const limitedList = await list(limited, '?pageSize=100');
    assert.equal(limitedList.status, 200, limitedList.text);
    assert.equal(limitedList.body.totalCount, ownerList.body.totalCount);
  });
});
