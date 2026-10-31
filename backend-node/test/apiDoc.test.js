// docs/API.md is generated from the route files. This test fails when a route is added, removed or re-protected without
// regenerating the file (run `npm run docs:api` in backend-node and commit the result). No database needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApiDoc, mountPrefixes, parseRouteFile } from '../scripts/generate-api-doc.js';

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/API.md');

describe('docs/API.md', () => {
  it('matches the routes in the source (run `npm run docs:api` to refresh it)', async () => {
    assert.equal(await readFile(DOC, 'utf8'), await buildApiDoc());
  });

  it('reads access from an alias, an inline permission, a bare sign-in and no middleware', () => {
    const source = `
      export function createDemoRouter({ env, pool }) {
        const router = Router();
        const viewOrders = [requireBearerAuth(env, pool), requirePermission('orders.view')];
        const signedIn = requireBearerAuth(env, pool);
        router.get('/a', ...viewOrders, async (req, res) => {});
        router.post('/b', publicLimit, ...[requireBearerAuth(env, pool), requirePermission('orders.manage')], async (req, res) => {});
        router.get('/c', signedIn, async (req, res) => {});
        router.get('/d', async (req, res) => {});
        router.get('/platform-admin/e', signedIn, async (req, res) => {});
      }`;
    const rows = parseRouteFile(source, 'demo.js', new Map([['createDemoRouter', '/api']]), new Map());
    assert.deepEqual(rows.map((r) => [r.method, r.path, r.access]), [
      ['GET', '/api/a', 'permission orders.view'],
      ['POST', '/api/b', 'permission orders.manage'],
      ['GET', '/api/c', 'signed in'],
      ['GET', '/api/d', 'public'],
      ['GET', '/api/platform-admin/e', 'signed in + platform admin (checked in service)'],
    ]);
    assert.deepEqual(rows[1].limits, ['publicLimit']);
  });

  it('reads mount prefixes from app.js', () => {
    const map = mountPrefixes("app.use('/api', createAXRouter({}));\napp.use('/', createPublicSiteRouter({}));");
    assert.equal(map.get('createAXRouter'), '/api');
    assert.equal(map.get('createPublicSiteRouter'), '');
  });
});
