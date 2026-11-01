// Step 17d-2: the list limits and optional paging for inventory, suppliers and purchase orders, over HTTP on real PostgreSQL,
// through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: with no paging parameters the list is still a plain array, now with total headers; page and pageSize give the standard
// envelope; the pages add up to the whole list with no row twice and a correct total; another business's rows never appear;
// a location-limited user sees only the rows of an assigned location (and the total counts only those); bad paging is a 400.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, firstLocationId, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;

describe('list limits and paging on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let limited; let noPerm;
  let mainLocation; let branchLocation; let otherLocation;
  const get = (who, path) => api.call('GET', path, { token: who.token });
  const post = async (who, path, body) => {
    const result = await api.call('POST', path, { token: who.token, body });
    assert.equal(result.status, 201, `${path}: ${result.text}`);
    return result.body;
  };
  const override = (businessId, key, value) => db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
    VALUES ($1,$2,now(),$3,'test fixture',$4)`, [randomUUID(), businessId, key, value]);
  const names = (items) => items.map((item) => item.name ?? item.Name ?? item.orderNumber ?? item.OrderNumber);
  const pagesOf = async (who, path, pageSize) => {
    const all = []; let total = null;
    for (let page = 1; page <= 10; page += 1) {
      const result = await get(who, `${path}?page=${page}&pageSize=${pageSize}`);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.page, page);
      assert.equal(result.body.pageSize, pageSize);
      total = result.body.totalCount;
      if (!result.body.items.length) break;
      all.push(...result.body.items);
    }
    return { all, total };
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_listlimits');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'll-owner');
    other = await signUp(api, 'll-other');
    for (const who of [owner, other]) {
      await upgradePlan(db, who.businessId, 'starter');
      await override(who.businessId, 'inventory.level', 'full');
    }
    await override(owner.businessId, 'users.max', 'unlimited');
    limited = await addStaff(api, db, owner, 'll-limited', ['inventory.view']);
    noPerm = await addStaff(api, db, owner, 'll-noperm', ['customers.view', 'locations.all']);

    mainLocation = await firstLocationId(db, owner.businessId);
    branchLocation = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Branch',TRUE,now())`, [branchLocation, owner.businessId]);
    const membership = (await db.pool.query(`SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId" WHERE u."Email" = $1 AND m."BusinessId" = $2`,
      [limited.email, owner.businessId])).rows[0].Id;
    await db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`, [membership, mainLocation, owner.businessId]);
    otherLocation = await firstLocationId(db, other.businessId);

    for (const [index, locationId] of [mainLocation, mainLocation, mainLocation, branchLocation, branchLocation].entries()) {
      await post(owner, '/api/inventory', { sku: `LL-${index}`, name: `Material ${index}`, unit: 'metre', locationId, openingStock: 5, reorderLevel: 1 });
    }
    await post(other, '/api/inventory', { sku: 'LL-X', name: 'Foreign material', unit: 'metre', locationId: otherLocation, openingStock: 5, reorderLevel: 1 });

    const suppliers = [];
    for (let index = 0; index < 5; index += 1) suppliers.push(await post(owner, '/api/suppliers', { name: `Supplier ${index}` }));
    const foreignSupplier = await post(other, '/api/suppliers', { name: 'Foreign supplier' });
    const po = (who, supplier, locationId, orderNumber) => post(who, '/api/purchase-orders', {
      supplierId: supplier.id, locationId, orderNumber, items: [{ description: 'Thread', quantityOrdered: 1, unitCost: 10 }] });
    for (let index = 0; index < 3; index += 1) await po(owner, suppliers[0], mainLocation, `PO-MAIN-${index}`);
    await po(owner, suppliers[1], branchLocation, 'PO-BRANCH-0');
    await po(other, foreignSupplier, otherLocation, 'PO-FOREIGN-0');
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('keeps the plain array without paging parameters and says how many rows there are', async () => {
    for (const [path, count] of [['/api/inventory', 5], ['/api/suppliers', 5], ['/api/purchase-orders', 4]]) {
      const result = await get(owner, path);
      assert.equal(result.status, 200, result.text);
      assert.ok(Array.isArray(result.body), path);
      assert.equal(result.body.length, count, path);
      assert.equal(result.headers.get('x-total-count'), String(count), path);
      assert.equal(result.headers.get('x-result-limit'), '1000', path);
      assert.equal(result.headers.get('x-truncated'), 'false', path);
    }
  });

  it('pages add up to the whole list: no row twice, a correct total, an empty page past the end', async () => {
    for (const [path, count] of [['/api/inventory', 5], ['/api/suppliers', 5], ['/api/purchase-orders', 4]]) {
      const { all, total } = await pagesOf(owner, path, 2);
      assert.equal(total, count, path);
      assert.equal(all.length, count, path);
      assert.equal(new Set(all.map((item) => item.id ?? item.Id)).size, count, `${path}: a row appeared twice`);
    }
    const inventory = await pagesOf(owner, '/api/inventory', 2);
    assert.deepEqual(names(inventory.all), ['Material 0', 'Material 1', 'Material 2', 'Material 3', 'Material 4']);
  });

  it('never shows another business', async () => {
    const inventory = names((await get(owner, '/api/inventory')).body);
    assert.ok(!inventory.includes('Foreign material'));
    assert.ok(!names((await get(owner, '/api/suppliers')).body).includes('Foreign supplier'));
    assert.ok(!names((await get(owner, '/api/purchase-orders')).body).includes('PO-FOREIGN-0'));
    const theirs = await get(other, '/api/inventory');
    assert.deepEqual(names(theirs.body), ['Foreign material']);
    assert.equal(theirs.headers.get('x-total-count'), '1');
  });

  it('counts and shows only the assigned location for a location-limited user', async () => {
    const inventory = await get(limited, '/api/inventory');
    assert.equal(inventory.body.length, 3);
    assert.equal(inventory.headers.get('x-total-count'), '3');
    const paged = await pagesOf(limited, '/api/inventory', 2);
    assert.equal(paged.total, 3);
    assert.deepEqual(names(paged.all), ['Material 0', 'Material 1', 'Material 2']);
    const orders = await get(limited, '/api/purchase-orders');
    assert.equal(orders.body.length, 3);
    assert.ok(!names(orders.body).includes('PO-BRANCH-0'));
    assert.equal(orders.headers.get('x-total-count'), '3');
  });

  it('refuses bad paging and a missing permission', async () => {
    for (const path of ['/api/inventory', '/api/suppliers', '/api/purchase-orders']) {
      assert.equal((await get(owner, `${path}?pageSize=500`)).status, 400, path);
      assert.equal((await get(owner, `${path}?page=0`)).status, 400, path);
      assert.equal((await get(noPerm, path)).status, 403, path);
    }
  });

  it('still exports every inventory row as CSV', async () => {
    const result = await get(owner, '/api/inventory/export');
    assert.equal(result.status, 200);
    assert.equal(result.text.trimEnd().split(/\r?\n/).length, 6, 'header and five rows');
  });
});
