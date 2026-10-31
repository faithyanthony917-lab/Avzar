import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const designId = '00000000-0000-4000-8000-000000000003';
const categoryId = '00000000-0000-4000-8000-000000000004';
const collectionId = '00000000-0000-4000-8000-000000000005';
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent', STOREFRONT_BASE_DOMAIN: 'avzar.app',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};

async function requestApp(app, pathname) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
    return { status: response.status, body: await response.text(), headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const siteRow = {
  Id: '00000000-0000-4000-8000-000000000006', BusinessId: businessId, Slug: 'shop', AllowSearchIndexing: true,
  PublishedVersionId: '00000000-0000-4000-8000-000000000007', VersionNumber: 4,
  DocumentJson: { pages: [{ visible: true, kind: 'home', slug: '' }] }, CreatedAtUtc: '2026-10-10T00:00:00.000Z',
};
const designRow = {
  Id: designId, Name: 'Evening dress', Slug: 'evening-dress', Kind: 'MadeToOrder', CategoryId: categoryId,
  BasePrice: '250.00', CurrencyCode: 'USD', IsFeatured: true, Description: 'A bespoke evening dress.',
  GarmentType: 'Dress', Tags: ['formal'], Fabrics: ['silk'], Colours: ['blue'], Sizes: ['S', 'M'], ProductionDays: 21,
};

function makePool({ domain = true, entitlement = true } = {}) {
  const statements = [];
  return {
    statements,
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes('FROM "Storefronts" s JOIN "StorefrontVersions"')) return { rows: [siteRow] };
      if (sql.includes('FROM "Designs"') && sql.includes('count(*)::int')) return { rows: [{ TotalCount: 1 }] };
      if (sql.includes('FROM "Designs" d') && sql.includes('"Slug" = $2')) return { rows: [designRow] };
      if (sql.includes('FROM "Designs"') && sql.includes('LIMIT $')) return { rows: [designRow] };
      if (sql.includes('FROM "DesignImages"') && sql.includes('DISTINCT ON')) return { rows: [{ DesignId: designId, MediaAssetId: '00000000-0000-4000-8000-000000000008', AltText: 'Front view' }] };
      if (sql.includes('FROM "DesignCategories"') && sql.includes('ANY($2::uuid[])')) return { rows: [{ Id: categoryId, Name: 'Evening wear' }] };
      if (sql.includes('SELECT "Name" FROM "DesignCategories"')) return { rows: [{ Name: 'Evening wear' }] };
      if (sql.includes('FROM "DesignImages"') && sql.includes('ORDER BY "SortOrder"')) return { rows: [{ MediaAssetId: '00000000-0000-4000-8000-000000000008', AltText: 'Front view' }] };
      if (sql.includes('FROM "DesignCategories" c')) return { rows: [{ Id: categoryId, Name: 'Evening wear' }] };
      if (sql.includes('FROM "DesignCollections"') && sql.includes('WHERE "BusinessId"')) return { rows: [{ Id: collectionId, Name: 'Occasion', Slug: 'occasion', Description: 'Special pieces' }] };
      if (sql.includes('FROM "DesignCollectionItems" ci')) return { rows: [designRow] };
      if (sql.includes('FROM "StorefrontDomains" d')) return { rows: domain ? [{ Slug: 'shop', BusinessId: businessId }] : [] };
      if (sql.includes('FROM "Plans" p')) return { rows: entitlement ? [{ Value: 'true' }] : [{ Value: 'false' }] };
      if (sql.includes('SELECT "Slug", "UpdatedAtUtc" FROM "Designs"')) return { rows: [{ Slug: designRow.Slug, UpdatedAtUtc: '2026-10-12T00:00:00.000Z' }] };
      if (sql.includes('SELECT "Slug" FROM "DesignCollections"')) return { rows: [{ Slug: 'occasion' }] };
      return { rows: [] };
    },
  };
}

describe('public design catalog', () => {
  it('lists, details, categorizes and renders collections from public active designs', async () => {
    const pool = makePool();
    const listResponse = await requestApp(createApp(env, pool), '/public/sites/shop/designs?pageSize=12&featured=true');
    assert.equal(listResponse.status, 200);
    const list = JSON.parse(listResponse.body);
    assert.equal(list.items[0].categoryName, 'Evening wear');
    assert.equal(list.items[0].basePrice, 250);
    assert.equal(list.items[0].coverAlt, 'Front view');
    const listSql = pool.statements.find(({ sql }) => sql.includes('FROM "Designs"') && sql.includes('LIMIT $'));
    assert.match(listSql.sql, /"Status" = 'Active'/);
    assert.match(listSql.sql, /"Visibility" = 'Public'/);
    assert.ok(listSql.values.includes(businessId));

    const detailResponse = await requestApp(createApp(env, makePool()), '/public/sites/shop/designs/evening-dress');
    const detail = JSON.parse(detailResponse.body);
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.categoryName, 'Evening wear');
    assert.deepEqual(detail.images, [{ mediaId: '00000000-0000-4000-8000-000000000008', alt: 'Front view' }]);

    const categoriesResponse = await requestApp(createApp(env, makePool()), '/public/sites/shop/categories');
    assert.deepEqual(JSON.parse(categoriesResponse.body), [{ id: categoryId, name: 'Evening wear' }]);

    const collectionResponse = await requestApp(createApp(env, makePool()), '/public/sites/shop/collections/occasion');
    const collection = JSON.parse(collectionResponse.body);
    assert.equal(collectionResponse.status, 200);
    assert.equal(collection.slug, 'occasion');
    assert.equal(collection.designs.length, 1);
  });

  it('validates paging and returns 404 for absent site/design/collection', async () => {
    const invalidPaging = await requestApp(createApp(env, makePool()), '/public/sites/shop/designs?pageSize=101');
    assert.equal(invalidPaging.status, 400);

    const missing = await requestApp(createApp(env, { query: async () => ({ rows: [] }) }), '/public/sites/missing/designs');
    assert.equal(missing.status, 404);
  });
});

describe('public domain and SEO endpoints', () => {
  it('resolves only verified domains whose tenant plan includes custom domains', async () => {
    const allowed = await requestApp(createApp(env, makePool()), '/public/resolve?host=shop.example.test');
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.body), { slug: 'shop' });

    const denied = await requestApp(createApp(env, makePool({ entitlement: false })), '/public/domains/allowed?domain=shop.example.test');
    assert.equal(denied.status, 404);
  });

  it('builds sitemap and robots output only for the storefront address', async () => {
    const pool = makePool();
    const sitemap = await requestApp(createApp(env, pool), '/public/sites/shop/sitemap.xml?baseUrl=https%3A%2F%2Fshop.avzar.app');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.body, /https:\/\/shop\.avzar\.app\/design\/evening-dress/);
    assert.match(sitemap.body, /https:\/\/shop\.avzar\.app\/collection\/occasion/);

    const invalid = await requestApp(createApp(env, makePool({ domain: false })), '/public/sites/shop/robots.txt?baseUrl=https%3A%2F%2Fevil.example.test');
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.body).code, 'invalid_base_url');

    const robots = await requestApp(createApp(env, makePool()), '/public/sites/shop/robots.txt?baseUrl=https%3A%2F%2Fshop.avzar.app');
    assert.equal(robots.status, 200);
    assert.match(robots.body, /Sitemap: https:\/\/shop\.avzar\.app\/sitemap\.xml/);
  });
});