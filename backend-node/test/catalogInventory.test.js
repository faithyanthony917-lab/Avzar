import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const env = {
  NODE_ENV: 'test',
  PORT: 8081,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api',
  JWT_AUDIENCE: 'avzar-mobile',
  ACCESS_TOKEN_MINUTES: 10,
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function bearerToken(userId = '00000000-0000-4000-8000-000000000001', businessId = '00000000-0000-4000-8000-000000000002', sessionId = '00000000-0000-4000-8000-000000000003') {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId }).token;
}

function designReadPool({ owner = true, permissions = ['designs.view'] } = {}) {
  const businessId = '00000000-0000-4000-8000-000000000002';
  const designId = '00000000-0000-4000-8000-000000000010';
  const calls = [];
  return {
    calls,
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships" m')) return { rows: [{
        UserId: values[0], Email: 'owner@example.test', FullName: 'Owner', BusinessId: values[1],
        BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: owner, Permissions: permissions,
      }] };
      if (sql.includes('count(*)::int AS "TotalCount" FROM "Designs"')) {
        return { rows: [{ TotalCount: values[0] === businessId ? 1 : 0 }] };
      }
      if (sql.includes('FROM "Designs" d')) {
        if (values[0] !== businessId) return { rows: [] };
        const row = {
          Id: designId, Name: 'Tailored Jacket', Slug: 'tailored-jacket', Kind: 'MadeToOrder', CategoryId: null,
          CategoryName: null, Description: 'Single-breasted jacket', GarmentType: 'Jacket', Tags: ['outerwear'],
          Fabrics: ['wool'], Colours: ['navy'], Sizes: ['M'], BasePrice: '280000.00', CurrencyCode: 'NGN',
          ProductionDays: 14, IsFeatured: true, Visibility: 'Private', Status: 'Active', ParentDesignId: null,
          Version: '1', CreatedAtUtc: new Date('2026-01-01T00:00:00.000Z'), CoverMediaId: null,
        };
        return { rows: [row] };
      }
      if (sql.includes('FROM "DesignImages"')) {
        return { rows: values[0] === businessId ? [{ MediaAssetId: '00000000-0000-4000-8000-000000000020', AltText: 'Front view', SortOrder: 0 }] : [] };
      }
      return { rows: [] };
    },
  };
}

function catalogWritePool() {
  const businessId = '00000000-0000-4000-8000-000000000002';
  const calls = [];
  let design;
  let category;
  let collection;
  let material;
  async function query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Memberships" m')) return { rows: [{
      UserId: '00000000-0000-4000-8000-000000000001', Email: 'owner@example.test', FullName: 'Owner',
      BusinessId: businessId, BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: true, Permissions: [],
    }] };
    if (sql.includes('SELECT "CurrencyCode" FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN' }] };
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: values[1] === 'inventory.level' ? 'full' : '100' }] };
    if (sql.includes('FROM "Locations" WHERE "BusinessId"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('SELECT COALESCE(override."Value"')) return { rows: [{ Value: '100' }] };
    if (sql.includes('count(*)::int AS "Count" FROM "Designs"')) return { rows: [{ Count: 0 }] };
    if (sql.includes('SELECT count(*)::int AS "TotalCount" FROM "DesignCollections"')) return { rows: [{ TotalCount: collection ? 1 : 0 }] };
    if (sql.includes('FROM "DesignCollections" c')) return { rows: collection ? [{
      Id: collection.Id, Name: collection.Name, Slug: collection.Slug, Visibility: collection.Visibility,
      SortOrder: collection.SortOrder, DesignCount: 0, PublicDesignCount: 0,
    }] : [] };
    if (sql.includes('FROM "DesignCollections" WHERE')) return { rows: collection ? [{ ...collection, Version: '1' }] : [] };
    if (sql.includes('FROM "DesignCollectionItems"')) return { rows: [] };
    if (sql.includes('FROM "Designs" d')) return { rows: design ? [{
      ...design, CategoryName: null, Version: '1', CreatedAtUtc: new Date('2026-01-01T00:00:00.000Z'), CoverMediaId: null,
    }] : [] };
    if (sql.includes('FROM "DesignImages"')) return { rows: [] };
    if (sql.includes('FROM "DesignCategories"')) return { rows: category ? [{
      Id: category.Id, Name: category.Name, SortOrder: category.SortOrder, DesignCount: 0,
    }] : [] };
    if (sql.includes('FROM "Materials" WHERE "BusinessId"')) return { rows: material ? [{ ...material, Version: '1' }] : [] };
    if (sql.includes('FROM "Materials" m')) return { rows: material ? [{ ...material, Version: '1' }] : [] };
    return { rows: [], rowCount: 1 };
  }
  return {
    calls,
    query,
    connect: async () => ({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('SELECT COALESCE(override."Value"')) return { rows: [{ Value: '100' }] };
        if (sql.includes('count(*)::int AS "Count" FROM "Designs"')) return { rows: [{ Count: 0 }] };
        if (sql.includes('SELECT "Slug" FROM "Designs"')) return { rows: [] };
        if (sql.includes('SELECT "Slug" FROM "DesignCollections"')) return { rows: [] };
        if (sql.includes('FROM "DesignCategories" WHERE')) return { rows: [] };
        if (sql.includes('INSERT INTO "Designs"')) {
          design = { Id: values[0], BusinessId: values[1], Name: values[2], Slug: values[3], Description: values[4],
            Kind: values[5], CategoryId: values[6], GarmentType: values[7], Tags: values[8], Fabrics: values[9],
            Colours: values[10], Sizes: values[11], BasePrice: values[12]?.toFixed?.(2) ?? values[12], CurrencyCode: values[13],
            ProductionDays: values[14], IsFeatured: values[15], Visibility: 'Private', Status: 'Active', ParentDesignId: values[16] };
        }
        if (sql.includes('INSERT INTO "DesignCategories"')) category = { Id: values[0], Name: values[2], SortOrder: values[3] };
        if (sql.includes('INSERT INTO "DesignCollections"')) collection = {
          Id: values[0], Name: values[2], Slug: values[3], Description: values[4], Visibility: values[5], SortOrder: values[6],
        };
        if (sql.includes('INSERT INTO "Materials"')) material = {
          Id: values[0], LocationId: values[2], Sku: values[3], Name: values[4], Unit: values[5],
          OnHand: values[6], Reserved: '0', ReorderLevel: values[7],
        };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
}

describe('catalog, pricing and inventory', () => {
  it('rejects design and inventory access without the relevant permissions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['orders.view'] }] };
        return { rows: [] };
      },
    };

    const designs = await requestApp(createApp(env, pool), '/api/designs', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(designs.status, 403);
    assert.equal(designs.body.code, 'forbidden');

    const inventory = await requestApp(createApp(env, pool), '/api/inventory', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(inventory.status, 403);
    assert.equal(inventory.body.code, 'forbidden');
  });

  it('allows catalog, pricing and inventory data to be read with the correct permissions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['designs.view', 'designs.manage', 'pricing.view', 'pricing.manage', 'inventory.view', 'inventory.manage'] }] };
        if (sql.includes('SELECT "CurrencyCode" FROM "Businesses"')) return { rows: [{ CurrencyCode: 'USD' }] };
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: values[1] === 'inventory.level' ? 'full' : '100' }] };
        if (sql.includes('FROM "Materials" m')) return { rows: [] };
        return { rows: [] };
      },
    };

    const designs = await requestApp(createApp(env, pool), '/api/designs', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(designs.status, 200);
    assert.equal(Array.isArray(designs.body.items), true);
    assert.equal(designs.body.page, 1);
    assert.equal(designs.body.totalCount, 0);

    const categories = await requestApp(createApp(env, pool), '/api/design-categories', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(categories.status, 200);
    assert.equal(Array.isArray(categories.body), true);

    const collections = await requestApp(createApp(env, pool), '/api/collections', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(collections.status, 200);
    assert.equal(Array.isArray(collections.body.items), true);

    const pricing = await requestApp(createApp(env, pool), '/api/pricing/profile', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(pricing.status, 200);
    assert.equal(pricing.body.isConfigured, false);

    const inventory = await requestApp(createApp(env, pool), '/api/inventory', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(inventory.status, 200);
    assert.equal(Array.isArray(inventory.body), true);
  });

  it('allows catalog and inventory writes when the permissions are present', async () => {
    const pool = catalogWritePool();

    const createDesign = await requestApp(createApp(env, pool), '/api/designs', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tailored Jacket', basePrice: 280000 }),
    });
    assert.equal(createDesign.status, 201);
    assert.equal(createDesign.body.name, 'Tailored Jacket');

    const createCategory = await requestApp(createApp(env, pool), '/api/design-categories', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Outerwear', sortOrder: 1 }),
    });
    assert.equal(createCategory.status, 201);
    assert.equal(createCategory.body.name, 'Outerwear');

    const createCollection = await requestApp(createApp(env, pool), '/api/collections', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Spring Edit', visibility: 'Private', sortOrder: 1 }),
    });
    assert.equal(createCollection.status, 201);
    assert.equal(createCollection.body.name, 'Spring Edit');

    const createInventory = await requestApp(createApp(env, pool), '/api/inventory', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'FAB-1001', name: 'Cotton Blend', unit: 'metre', openingStock: 30, reorderLevel: 8, locationId: '00000000-0000-4000-8000-000000000020' }),
    });
    assert.equal(createInventory.status, 201);
    assert.equal(createInventory.body.sku, 'FAB-1001');
  });
});

describe('design read isolation', () => {
  it('returns paged summaries and a full detail from the authenticated business', async () => {
    const pool = designReadPool();
    const list = await requestApp(createApp(env, pool), '/api/designs?page=1&pageSize=25', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(list.status, 200);
    assert.equal(list.body.totalCount, 1);
    assert.equal(list.body.items[0].slug, 'tailored-jacket');
    assert.equal(list.body.items[0].coverMediaId, null);

    const detail = await requestApp(createApp(env, pool), '/api/designs/00000000-0000-4000-8000-000000000010', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.images, [{ mediaId: '00000000-0000-4000-8000-000000000020', altText: 'Front view', sortOrder: 0 }]);
    const designQueries = pool.calls.filter((call) => call.sql.includes('FROM "Designs" d'));
    assert.equal(designQueries.every((call) => call.values[0] === '00000000-0000-4000-8000-000000000002'), true);
  });

  it('rejects invalid paging, missing authentication, denied permission, and cross-business design reads', async () => {
    const invalid = await requestApp(createApp(env, designReadPool()), '/api/designs?pageSize=101', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_paging');

    const unauthenticated = await requestApp(createApp(env, designReadPool()), '/api/designs');
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(env, designReadPool({ owner: false, permissions: ['orders.view'] })), '/api/designs', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(forbidden.status, 403);

    const crossBusiness = await requestApp(createApp(env, designReadPool()), '/api/designs/00000000-0000-4000-8000-000000000010', {
      headers: { authorization: `Bearer ${bearerToken('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000022')}` },
    });
    assert.equal(crossBusiness.status, 404);
  });
});
