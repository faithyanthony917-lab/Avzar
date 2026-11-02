// Step 18a: reference images on an order, over HTTP on real PostgreSQL, through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: upload, list and stream work and keep the caption; the images never appear in the media library, in public media or as a
// logo; another business cannot list, stream, add or remove them; a location-limited user reaches only the orders of an assigned
// location; a viewer cannot upload; a worker sees them only through a task assigned to them; the limit of 10 and the cancelled-order
// rule hold; removing an image deletes its link, its media row and writes an audit entry; bad input is refused and leaves no row.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { assertLogoMedia } from '../../src/auth/businessSettings.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, firstLocationId, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('order reference images on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let limited; let viewer; let worker;
  let mainLocation; let branchLocation; let otherLocation;
  let mainOrder; let branchOrder; let otherOrder; let workerTask; let strangerTask;
  let png;

  const override = (businessId, key, value) => db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
    VALUES ($1,$2,now(),$3,'test fixture',$4)`, [randomUUID(), businessId, key, value]);
  const membershipOf = async (who) => (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE u."Email" = $1 AND m."BusinessId" = $2`, [who.email, who.businessId])).rows[0].Id;
  const multipart = (bytes, caption, fileName = 'ref.png') => {
    const boundary = `----avzar${randomUUID()}`;
    const parts = [];
    if (caption !== undefined) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };
  const upload = (who, orderId, caption, bytes = png) => api.call('POST', `/api/orders/${orderId}/reference-images`, { token: who.token, ...multipart(bytes, caption) });
  const list = (who, orderId) => api.call('GET', `/api/orders/${orderId}/reference-images`, { token: who.token });
  const addImage = async (who, orderId, caption) => {
    const result = await upload(who, orderId, caption);
    assert.equal(result.status, 201, result.text);
    return result.body;
  };
  const insertOrder = async (businessId, locationId, status = 'Confirmed') => {
    const customerId = randomUUID(); const orderId = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Reference customer','Active')`, [customerId, businessId]);
    await db.pool.query(`INSERT INTO "Orders" ("Id","BusinessId","CreatedAtUtc","CurrencyCode","CustomerId","DeliveryMethod","Discount","LocationId","OrderNumber","Priority","PromisedDate","Status","Subtotal","Total")
      VALUES ($1,$2,now(),'NGN',$3,'Collection',0,$4,$5,'Normal',current_date,$6,1000,1000)`, [orderId, businessId, customerId, locationId, `REF-${orderId.replaceAll('-', '').slice(0, 20)}`, status]);
    return orderId;
  };
  const insertTask = async (businessId, orderId, membershipId) => {
    const garmentId = randomUUID(); const taskId = randomUUID();
    await db.pool.query(`INSERT INTO "OrderGarments" ("Id","BusinessId","CreatedAtUtc","LineNumber","LineTotal","Name","OrderId","Quantity","UnitPrice") VALUES ($1,$2,now(),1,1000,'Reference garment',$3,1,1000)`, [garmentId, businessId, orderId]);
    await db.pool.query(`INSERT INTO "ProductionTasks" ("Id","BusinessId","CreatedAtUtc","IsConditional","OrderGarmentId","OrderId","Priority","Quantity","RequiredMaterialsJson","StageName","StageOrder","Status","Title","AssignedMembershipId")
      VALUES ($1,$2,now(),FALSE,$3,$4,'Normal',1,'[]'::jsonb,'Cutting',1,'Pending','Reference task',$5)`, [taskId, businessId, garmentId, orderId, membershipId]);
    return taskId;
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_refimages');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 60, b: 60 } } }).png().toBuffer();
    owner = await signUp(api, 'ri-owner');
    other = await signUp(api, 'ri-other');
    for (const who of [owner, other]) {
      await upgradePlan(db, who.businessId, 'starter');
      await override(who.businessId, 'storage.gb.max', '1');
    }
    await override(owner.businessId, 'users.max', 'unlimited');
    limited = await addStaff(api, db, owner, 'ri-limited', ['orders.view', 'orders.manage']);
    viewer = await addStaff(api, db, owner, 'ri-viewer', ['orders.view', 'locations.all']);
    worker = await addStaff(api, db, owner, 'ri-worker', ['tasks.work']);

    mainLocation = await firstLocationId(db, owner.businessId);
    branchLocation = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Branch',TRUE,now())`, [branchLocation, owner.businessId]);
    await db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`, [await membershipOf(limited), mainLocation, owner.businessId]);
    otherLocation = await firstLocationId(db, other.businessId);

    mainOrder = await insertOrder(owner.businessId, mainLocation);
    branchOrder = await insertOrder(owner.businessId, branchLocation);
    otherOrder = await insertOrder(other.businessId, otherLocation);
    workerTask = await insertTask(owner.businessId, mainOrder, await membershipOf(worker));
    const strangerOrder = await insertOrder(owner.businessId, mainLocation);
    strangerTask = await insertTask(owner.businessId, strangerOrder, await membershipOf(worker));
    await addImage(owner, strangerOrder, 'Belongs to the stranger order');
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('adds, lists and streams a reference image and keeps the caption', async () => {
    const added = await addImage(owner, mainOrder, 'Front panel');
    assert.equal(added.caption, 'Front panel');
    assert.equal(added.orderId, mainOrder);
    const listed = await list(owner, mainOrder);
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.maxImages, 10);
    assert.deepEqual(listed.body.items.map((item) => item.caption), ['Front panel']);
    for (const variant of ['orig', 'md', 'sm']) {
      const file = await api.call('GET', `/api/orders/${mainOrder}/reference-images/${added.id}/file/${variant}`, { token: owner.token });
      assert.equal(file.status, 200, `${variant}: ${file.text.slice(0, 80)}`);
      assert.equal(file.contentType, 'image/webp');
      assert.match(file.headers.get('cache-control') ?? '', /private/);
    }
    assert.equal((await api.call('GET', `/api/orders/${mainOrder}/reference-images/${added.id}/file/huge`, { token: owner.token })).status, 404);
  });

  it('keeps the images out of the media library, public media and the logo', async () => {
    const [image] = (await list(owner, mainOrder)).body.items;
    const library = await api.call('GET', '/api/media', { token: owner.token });
    assert.equal(library.status, 200, library.text);
    assert.ok(!library.body.items.some((item) => item.id === image.mediaId), 'the library must not list a reference image');
    assert.equal((await api.call('GET', `/api/media/${image.mediaId}`, { token: owner.token })).status, 404);
    assert.equal((await api.call('GET', `/api/media/${image.mediaId}/file/md`, { token: owner.token })).status, 404);
    assert.equal((await api.call('GET', `/api/public/media/${image.mediaId}/md`)).status, 404);
    await assert.rejects(assertLogoMedia(db.pool, owner.businessId, image.mediaId), (error) => error.code === 'media_not_found' || error.status === 404);
  });

  it('never shows or changes another business', async () => {
    const [image] = (await list(owner, mainOrder)).body.items;
    assert.equal((await list(other, mainOrder)).status, 404);
    assert.equal((await api.call('GET', `/api/orders/${mainOrder}/reference-images/${image.id}/file/md`, { token: other.token })).status, 404);
    assert.equal((await upload(other, mainOrder, 'intruder')).status, 404);
    assert.equal((await api.call('DELETE', `/api/orders/${mainOrder}/reference-images/${image.id}`, { token: other.token })).status, 404);
    assert.equal((await api.call('GET', `/api/orders/${otherOrder}/reference-images/${image.id}/file/md`, { token: other.token })).status, 404, 'an image ID of another business under my own order');
    assert.equal((await list(owner, mainOrder)).body.items.length, 1, 'the owner still has the image');
    assert.equal((await list(other, otherOrder)).body.items.length, 0);
  });

  it('gives a location-limited user only the orders of an assigned location, and a viewer cannot upload', async () => {
    assert.equal((await list(limited, mainOrder)).status, 200);
    assert.equal((await upload(limited, mainOrder, 'from the limited user')).status, 201);
    assert.equal((await list(limited, branchOrder)).status, 404);
    assert.equal((await upload(limited, branchOrder, 'wrong location')).status, 404);
    await addImage(owner, branchOrder, 'Branch image');
    const [branchImage] = (await list(owner, branchOrder)).body.items;
    assert.equal((await api.call('GET', `/api/orders/${branchOrder}/reference-images/${branchImage.id}/file/md`, { token: limited.token })).status, 404);
    assert.equal((await api.call('DELETE', `/api/orders/${branchOrder}/reference-images/${branchImage.id}`, { token: limited.token })).status, 404);
    assert.equal((await list(viewer, mainOrder)).status, 200);
    assert.equal((await upload(viewer, mainOrder, 'no permission')).status, 403);
  });

  it('shows a worker the images only through a task assigned to them', async () => {
    const mine = await api.call('GET', `/api/my/tasks/${workerTask}/reference-images`, { token: worker.token });
    assert.equal(mine.status, 200, mine.text);
    assert.ok(mine.body.items.length >= 1);
    assert.ok(mine.body.items.every((item) => item.orderId === mainOrder));
    const file = await api.call('GET', `/api/my/tasks/${workerTask}/reference-images/${mine.body.items[0].id}/file/md`, { token: worker.token });
    assert.equal(file.status, 200);
    // The stranger task is also assigned to this worker, but belongs to another order: its image must not open under the first task.
    const strangerImages = await api.call('GET', `/api/my/tasks/${strangerTask}/reference-images`, { token: worker.token });
    assert.deepEqual(strangerImages.body.items.map((item) => item.caption), ['Belongs to the stranger order']);
    const crossed = await api.call('GET', `/api/my/tasks/${workerTask}/reference-images/${strangerImages.body.items[0].id}/file/md`, { token: worker.token });
    assert.equal(crossed.status, 404);
    // Not assigned to the owner's own membership: another user with tasks.work cannot read it.
    const nobody = await addStaff(api, db, owner, 'ri-worker2', ['tasks.work']);
    const notMine = await api.call('GET', `/api/my/tasks/${workerTask}/reference-images`, { token: nobody.token });
    assert.equal(notMine.status, 200);
    assert.equal(notMine.body.items.length, 0);
    assert.equal((await api.call('GET', `/api/my/tasks/${workerTask}/reference-images/${mine.body.items[0].id}/file/md`, { token: nobody.token })).status, 404);
    assert.equal((await list(worker, mainOrder)).status, 403, 'a worker without orders.view cannot use the order route');
  });

  it('allows at most 10 images per order and refuses a cancelled order', async () => {
    const order = await insertOrder(owner.businessId, mainLocation);
    for (let index = 0; index < 10; index += 1) await addImage(owner, order, `Image ${index}`);
    const eleventh = await upload(owner, order, 'too many');
    assert.equal(eleventh.status, 409, eleventh.text);
    assert.equal(eleventh.body.code ?? eleventh.body.error?.code, 'reference_image_limit');
    assert.equal((await list(owner, order)).body.items.length, 10);
    const count = (await db.pool.query(`SELECT count(*)::int AS n FROM "MediaAssets" WHERE "BusinessId" = $1 AND "Purpose" = 'OrderReferenceImage'`, [owner.businessId])).rows[0].n;
    const linked = (await db.pool.query(`SELECT count(*)::int AS n FROM "OrderReferenceImages" WHERE "BusinessId" = $1`, [owner.businessId])).rows[0].n;
    assert.equal(count, linked, 'a refused upload must leave no media row behind');
    const [first] = (await list(owner, order)).body.items;
    assert.equal((await api.call('DELETE', `/api/orders/${order}/reference-images/${first.id}`, { token: owner.token })).status, 204);
    assert.equal((await upload(owner, order, 'room again')).status, 201);
    const cancelled = await insertOrder(owner.businessId, mainLocation, 'Cancelled');
    const refused = await upload(owner, cancelled, 'cancelled');
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.code ?? refused.body.error?.code, 'order_not_editable');
  });

  it('removes the link, the media row and the stored file, and writes an audit entry', async () => {
    const order = await insertOrder(owner.businessId, mainLocation);
    const added = await addImage(owner, order, 'To remove');
    assert.equal((await api.call('DELETE', `/api/orders/${order}/reference-images/${added.id}`, { token: owner.token })).status, 204);
    assert.equal((await list(owner, order)).body.items.length, 0);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "MediaAssets" WHERE "Id" = $1`, [added.mediaId])).rows[0].n, 0);
    assert.equal((await api.call('GET', `/api/orders/${order}/reference-images/${added.id}/file/md`, { token: owner.token })).status, 404);
    assert.equal((await api.call('DELETE', `/api/orders/${order}/reference-images/${added.id}`, { token: owner.token })).status, 404);
    const audit = await db.pool.query(`SELECT "Action" FROM "AuditLogs" WHERE "BusinessId" = $1 AND "EntityId" = $2 ORDER BY "CreatedAtUtc"`, [owner.businessId, order]);
    assert.deepEqual(audit.rows.map((row) => row.Action), ['order.reference_image.added', 'order.reference_image.removed']);
  });

  it('refuses a file that is not an image and a caption that is too long, and leaves no row', async () => {
    const order = await insertOrder(owner.businessId, mainLocation);
    const notImage = await upload(owner, order, 'text', Buffer.from('this is not an image'));
    assert.equal(notImage.status, 400, notImage.text);
    const tooLong = await upload(owner, order, 'x'.repeat(501));
    assert.equal(tooLong.status, 400, tooLong.text);
    assert.equal((await list(owner, order)).body.items.length, 0);
    assert.equal((await api.call('POST', `/api/orders/${order}/reference-images`, { token: owner.token, body: {} })).status, 400);
  });

  it('does not let the general media upload create a reference image that nothing links to', async () => {
    const boundary = `----avzar${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nOrderReferenceImage\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="loose.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const before = (await db.pool.query(`SELECT count(*)::int AS n FROM "MediaAssets" WHERE "BusinessId" = $1`, [owner.businessId])).rows[0].n;
    const result = await api.call('POST', '/api/media', { token: owner.token, body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    assert.equal(result.status, 400, result.text);
    assert.equal(result.body.code, 'invalid_purpose');
    const after = (await db.pool.query(`SELECT count(*)::int AS n FROM "MediaAssets" WHERE "BusinessId" = $1`, [owner.businessId])).rows[0].n;
    assert.equal(after, before, 'a refused upload must leave no media row behind');
  });
});
