// Real PostgreSQL coverage for task-photo tenant, location, and assignment isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { migrate } from '../../src/db/migrate.js';
import { openTaskPhoto } from '../../src/auth/mediaService.js';
import { assertLogoMedia } from '../../src/auth/businessSettings.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;

describe('task progress photo isolation on PostgreSQL', { skip: !url }, () => {
  let db;
  let pool;
  const ids = {};
  const openedKeys = [];
  const storage = {
    async openRead(key) {
      openedKeys.push(key);
      return Readable.from([]);
    },
  };

  async function insertBusiness(name) {
    const id = randomUUID();
    await pool.query(`INSERT INTO "Businesses" ("Id","Name","IsActive","TimeZoneId","CurrencyCode","CreatedAtUtc") VALUES ($1,$2,TRUE,'UTC','NGN',now())`, [id, name]);
    return id;
  }

  async function insertMembership(businessId, label) {
    const userId = randomUUID();
    const membershipId = randomUUID();
    await pool.query(`INSERT INTO "AspNetUsers" ("Id","Email","NormalizedEmail","UserName","NormalizedUserName","FullName","EmailConfirmed","PhoneNumberConfirmed","TwoFactorEnabled","LockoutEnabled","AccessFailedCount","SecurityStamp","ConcurrencyStamp","CreatedAtUtc") VALUES ($1,$2,$3,$2,$3,$4,TRUE,FALSE,FALSE,FALSE,0,'s','c',now())`, [userId, `${label}@example.test`, `${label}@example.test`.toUpperCase(), label]);
    await pool.query(`INSERT INTO "Memberships" ("Id","BusinessId","CreatedAtUtc","DisplayName","IsOwner","Status","UserId") VALUES ($1,$2,now(),$3,FALSE,0,$4)`, [membershipId, businessId, label, userId]);
    return membershipId;
  }

  async function insertLocation(businessId, name) {
    const id = randomUUID();
    await pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,$3,TRUE,now())`, [id, businessId, name]);
    return id;
  }

  async function insertCustomer(businessId, name) {
    const id = randomUUID();
    await pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),$3,'Active')`, [id, businessId, name]);
    return id;
  }

  async function insertOrder(businessId, customerId, locationId) {
    const id = randomUUID();
    await pool.query(`INSERT INTO "Orders" ("Id","BusinessId","CreatedAtUtc","CurrencyCode","CustomerId","DeliveryMethod","Discount","LocationId","OrderNumber","Priority","PromisedDate","Status","Subtotal","Total") VALUES ($1,$2,now(),'NGN',$3,'Collection',0,$4,$5,'Normal',current_date,'Confirmed',1000,1000)`, [id, businessId, customerId, locationId, `PHOTO-${id.replaceAll('-', '').slice(0, 24)}`]);
    return id;
  }

  async function insertTask(businessId, orderId, membershipId) {
    const garmentId = randomUUID();
    const taskId = randomUUID();
    await pool.query(`INSERT INTO "OrderGarments" ("Id","BusinessId","CreatedAtUtc","LineNumber","LineTotal","Name","OrderId","Quantity","UnitPrice") VALUES ($1,$2,now(),1,1000,'Photo test garment',$3,1,1000)`, [garmentId, businessId, orderId]);
    await pool.query(`INSERT INTO "ProductionTasks" ("Id","BusinessId","CreatedAtUtc","IsConditional","OrderGarmentId","OrderId","Priority","Quantity","RequiredMaterialsJson","StageName","StageOrder","Status","Title","AssignedMembershipId") VALUES ($1,$2,now(),FALSE,$3,$4,'Normal',1,'[]'::jsonb,'Cutting',1,'Pending','Photo access test',$5)`, [taskId, businessId, garmentId, orderId, membershipId]);
    return taskId;
  }

  async function insertPhoto(businessId, taskId, membershipId) {
    const mediaId = randomUUID();
    const photoId = randomUUID();
    await pool.query(`INSERT INTO "MediaAssets" ("Id","BusinessId","ContentType","CreatedAtUtc","Height","OriginalFileName","Purpose","Sha256","SizeBytes","Width") VALUES ($1,$2,'image/webp',now(),10,'progress.webp','TaskProgressPhoto',$3,100,10)`, [mediaId, businessId, 'a'.repeat(64)]);
    await pool.query(`INSERT INTO "TaskProgressPhotos" ("Id","BusinessId","TaskId","MediaAssetId","UploadedByMembershipId","Caption","UploadedAtUtc") VALUES ($1,$2,$3,$4,$5,'test',now())`, [photoId, businessId, taskId, mediaId, membershipId]);
    return { mediaId, photoId };
  }

  before(async () => {
    db = await createTempDatabase(url, 'avzar_photo');
    pool = db.pool;
    await migrate(pool, MIGRATIONS_DIR, quiet);
    ids.businessA = await insertBusiness('Photo tenant A');
    ids.businessB = await insertBusiness('Photo tenant B');
    ids.memberA = await insertMembership(ids.businessA, 'photo-a');
    ids.memberB = await insertMembership(ids.businessB, 'photo-b');
    ids.locationAllowed = await insertLocation(ids.businessA, 'Allowed');
    ids.locationDenied = await insertLocation(ids.businessA, 'Denied');
    ids.customerA = await insertCustomer(ids.businessA, 'Customer A');
    ids.customerB = await insertCustomer(ids.businessB, 'Customer B');
    ids.taskA = await insertTask(ids.businessA,
      await insertOrder(ids.businessA, ids.customerA, ids.locationAllowed), ids.memberA);
    ids.taskDenied = await insertTask(ids.businessA,
      await insertOrder(ids.businessA, ids.customerA, ids.locationDenied), ids.memberA);
    ids.taskB = await insertTask(ids.businessB,
      await insertOrder(ids.businessB, ids.customerB, await insertLocation(ids.businessB, 'Tenant B')), ids.memberB);
    ids.photoA = await insertPhoto(ids.businessA, ids.taskA, ids.memberA);
    ids.photoDenied = await insertPhoto(ids.businessA, ids.taskDenied, ids.memberA);
    ids.photoB = await insertPhoto(ids.businessB, ids.taskB, ids.memberB);
  });

  after(async () => { await db?.drop(); });

  it('opens a photo only for its task, tenant, location, and assigned worker', async () => {
    const allowed = await openTaskPhoto(pool, storage, { businessId: ids.businessA }, ids.taskA, ids.photoA.photoId,
      'md', [ids.locationAllowed], null);
    assert.equal(allowed.contentType, 'image/webp');
    assert.equal(openedKeys.length, 1);

    const deniedCases = [
      [{ businessId: ids.businessB }, ids.taskA, ids.photoA.photoId, null, null],
      [{ businessId: ids.businessA }, ids.taskB, ids.photoB.photoId, null, null],
      [{ businessId: ids.businessA }, ids.taskDenied, ids.photoDenied.photoId, [ids.locationAllowed], null],
      [{ businessId: ids.businessA }, ids.taskA, ids.photoA.photoId, null, ids.memberB],
    ];
    for (const [user, taskId, photoId, locations, membershipId] of deniedCases) {
      await assert.rejects(openTaskPhoto(pool, storage, user, taskId, photoId, 'orig', locations, membershipId), { code: 'task_photo_not_found' });
    }
    assert.equal(openedKeys.length, 1);
  });

  it('rejects a photo row that combines a business with another tenant task', async () => {
    await assert.rejects(pool.query(`INSERT INTO "TaskProgressPhotos" ("Id","BusinessId","TaskId","MediaAssetId","UploadedByMembershipId","Caption","UploadedAtUtc") VALUES ($1,$2,$3,$4,$5,'cross-tenant',now())`, [randomUUID(), ids.businessB, ids.taskA, ids.photoB.mediaId, ids.memberB]), /FK_TaskProgressPhotos_ProductionTasks_TaskId_BusinessId/);
  });

  it('does not accept a task progress photo as the business logo', async () => {
    await assert.rejects(assertLogoMedia(pool, ids.businessA, ids.photoA.mediaId), { code: 'media_not_found' });
    await assert.rejects(assertLogoMedia(pool, ids.businessB, ids.photoA.mediaId), { code: 'media_not_found' });
    const logoId = randomUUID();
    await pool.query(`INSERT INTO "MediaAssets" ("Id","BusinessId","ContentType","CreatedAtUtc","Height","OriginalFileName","Purpose","Sha256","SizeBytes","Width") VALUES ($1,$2,'image/webp',now(),1,'logo.webp','SiteImage',$3,1,1)`, [logoId, ids.businessA, 'f'.repeat(64)]);
    await assertLogoMedia(pool, ids.businessA, logoId);
    await assert.rejects(assertLogoMedia(pool, ids.businessB, logoId), { code: 'media_not_found' });
  });
});
