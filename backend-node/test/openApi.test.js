// docs/openapi.json is generated from the route files like docs/API.md. This test fails when it is out of date (run
// `npm run docs:api` in backend-node and commit the result) and checks that it is a sound OpenAPI 3.1 skeleton. No database needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi, buildOpenApiFile, collectRows, openApiPath, OPTIONAL_PAGING } from '../scripts/generate-api-doc.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');
const operations = (spec) => Object.entries(spec.paths).flatMap(([route, item]) =>
  Object.entries(item).filter(([key]) => key !== 'parameters').map(([method, operation]) => ({ route, method, operation, item })));

describe('docs/openapi.json', () => {
  it('matches the routes in the source (run `npm run docs:api` to refresh it)', async () => {
    assert.equal(await readFile(path.join(DOCS, 'openapi.json'), 'utf8'), await buildOpenApiFile());
  });

  it('describes every route in docs/API.md exactly once', async () => {
    const rows = await collectRows();
    const spec = JSON.parse(await readFile(path.join(DOCS, 'openapi.json'), 'utf8'));
    const described = operations(spec);
    assert.equal(described.length, rows.length);
    const apiMd = await readFile(path.join(DOCS, 'API.md'), 'utf8');
    assert.match(apiMd, new RegExp(`${rows.length} routes in`));
    assert.equal(new Set(described.map((o) => o.operation.operationId)).size, described.length, 'operation IDs are unique');
    for (const row of rows) {
      const found = described.find((o) => o.route === openApiPath(row.path) && o.method === row.method.toLowerCase());
      assert.ok(found, `${row.method} ${row.path} is missing`);
    }
  });

  it('declares every path parameter and marks public and signed-in routes correctly', async () => {
    const spec = JSON.parse(await readFile(path.join(DOCS, 'openapi.json'), 'utf8'));
    assert.equal(spec.openapi, '3.1.0');
    for (const { route, item, operation } of operations(spec)) {
      const declared = (item.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
      assert.deepEqual([...route.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), declared, route);
      assert.ok(Array.isArray(operation.security), route);
      assert.equal(operation.security.length === 0, operation['x-access'] === 'public', `${route}: security matches x-access`);
      assert.ok(operation.responses['200'] && operation.responses['400'], route);
    }
  });

  it('marks the lists that take optional paging, and only those', async () => {
    const spec = JSON.parse(await readFile(path.join(DOCS, 'openapi.json'), 'utf8'));
    const marked = operations(spec).filter((o) => o.operation['x-paging']).map((o) => `${o.method.toUpperCase()} ${o.route.replace(/\{(\w+)\}/g, ':$1')}`).sort();
    assert.deepEqual(marked, [...OPTIONAL_PAGING].sort());
  });

  it('holds no secret-looking value and no absolute server address', async () => {
    const text = await readFile(path.join(DOCS, 'openapi.json'), 'utf8');
    assert.doesNotMatch(text, /sk_(live|test)_|whsec_|postgres(ql)?:\/\/|localhost|127\.0\.0\.1/);
    assert.deepEqual(JSON.parse(text).servers, [{ url: '/' }]);
  });
});

describe('buildOpenApi', () => {
  const rows = [
    { method: 'GET', path: '/api/orders/:id', file: 'auth/orderRoutes.js', access: 'permission orders.view', limits: [] },
    { method: 'POST', path: '/api/orders/:id', file: 'auth/orderRoutes.js', access: 'permission orders.manage + orders.view', limits: ['writeLimit'] },
    { method: 'GET', path: '/api/public/shop', file: 'auth/publicRoutes.js', access: 'public', limits: ['publicLimit'] },
    { method: 'GET', path: '/api/public/shop', file: 'auth/otherRoutes.js', access: 'public', limits: [] },
    { method: 'GET', path: '/api/orders/export', file: 'auth/orderRoutes.js', access: 'permission orders.view', limits: [] },
    { method: 'GET', path: '/api/inventory', file: 'auth/catalogRoutes.js', access: 'permission inventory.view', limits: [] },
  ];
  const spec = JSON.parse(buildOpenApi(rows, '9.9.9'));

  it('converts :params, tags by route file and carries permissions and limiters', () => {
    const get = spec.paths['/api/orders/{id}'].get;
    assert.deepEqual(spec.paths['/api/orders/{id}'].parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    assert.deepEqual(get.tags, ['orderRoutes']);
    assert.deepEqual(get.security, [{ bearerAuth: [] }]);
    assert.deepEqual(get['x-permissions'], ['orders.view']);
    assert.ok(get.responses['401'] && get.responses['403'] && get.responses['404']);
    const post = spec.paths['/api/orders/{id}'].post;
    assert.deepEqual(post['x-permissions'], ['orders.manage', 'orders.view']);
    assert.deepEqual(post['x-rate-limits'], ['writeLimit']);
    assert.ok(post.responses['429']);
  });

  it('leaves a public route open, keeps the first of a duplicate and adds export and paging details', () => {
    const open = spec.paths['/api/public/shop'].get;
    assert.deepEqual(open.security, []);
    assert.equal(open.responses['401'], undefined);
    assert.deepEqual(open.tags, ['publicRoutes']);
    assert.ok(spec.paths['/api/orders/export'].get.responses['413']);
    assert.equal(spec.paths['/api/inventory'].get['x-paging'], 'optional');
    assert.equal(spec.info.version, '9.9.9');
  });

  it('gives every operation its own ID', () => {
    const ids = operations(spec).map((o) => o.operation.operationId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes('getApiOrdersId') && ids.includes('postApiOrdersId'));
  });
});
