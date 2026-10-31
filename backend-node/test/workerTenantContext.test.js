import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanOrphanObjects } from '../src/storage/orphanCleanup.js';
import { installTenantRlsContext } from '../src/db/tenantRlsContext.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

// Row-level security makes a query with no tenant see nothing. A worker that forgets to set one does not crash: it finds no work,
// or worse, concludes that everything is missing. This guard fails the build when a worker started by server.js sets no tenant.
test('every worker that server.js starts runs its work inside a tenant context', () => {
  const server = readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const workers = [...server.matchAll(/import \{ (start\w+) \} from '(\.[^']+)'/g)].map((m) => ({ name: m[1], file: path.join(SRC, m[2]) }));
  assert.ok(workers.length >= 10, `expected the ten workers, found ${workers.length}`);
  for (const { name, file } of workers) {
    const source = readFileSync(file, 'utf8');
    assert.ok(/forEachBusiness\(|runWithTenantRlsContext\(/.test(source), `${name} (${path.relative(SRC, file)}) must run under a tenant context`);
  }
});

const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hexA = BIZ_A.replaceAll('-', '');
const hexB = BIZ_B.replaceAll('-', '');
const live = '11111111111111111111111111111111';
const gone = '22222222222222222222222222222222';
const other = '33333333333333333333333333333333';
const now = new Date('2026-10-22T12:00:00.000Z');
const old = new Date(now.getTime() - 30 * 3_600_000).toISOString();

test('orphan cleanup looks each object up under its own business, so a restricted role does not see every object as an orphan', async () => {
  const deleted = [];
  const lookups = [];
  const rows = (text, settings) => {
    // The live asset exists only for business A, and is visible only when A is the tenant: what the policy enforces.
    if (settings['app.business_id'] !== BIZ_A) return { rows: [] };
    return text.includes('"MediaAssets"') ? { rows: [{ Id: live, BusinessId: BIZ_A }] } : { rows: [] };
  };
  const pool = installTenantRlsContext({
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() {
      let settings = {};
      return {
        async query(sql, values) {
          const text = String(sql);
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) { settings = {}; return { rows: [] }; }
          if (text.includes("set_config('app.business_id'")) { settings['app.business_id'] = values[0]; return { rows: [] }; }
          lookups.push({ text, settings: { ...settings } });
          return rows(text, settings);
        },
        release() {},
      };
    },
  });
  const keys = [`${hexA}/${live}/orig.webp`, `${hexA}/${gone}/orig.webp`, `${hexB}/${other}/orig.webp`];
  const storage = {
    async *list() { for (const key of keys) yield { key, lastModifiedUtc: old }; },
    async delete(key) { deleted.push(key); },
  };
  const result = await cleanOrphanObjects({ pool, storage, now, log: {} });
  assert.deepEqual(deleted.sort(), [`${hexA}/${gone}/orig.webp`, `${hexB}/${other}/orig.webp`].sort());
  assert.equal(result.deleted, 2);
  assert.ok(lookups.length >= 2 && lookups.every((q) => q.settings['app.business_id']), 'every lookup must run with a business context');
  assert.ok(lookups.some((q) => q.settings['app.business_id'] === BIZ_B), 'business B objects are checked under B');
});

test('orphan cleanup keeps objects of a business whose ID the tenant context refuses, instead of deleting on a guess', async () => {
  const deleted = [];
  const pool = installTenantRlsContext({ async query() { return { rows: [] }; }, async connect() { return { async query() { return { rows: [] }; }, release() {} }; } });
  const badHex = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // version nibble 'a' is not a UUID the context accepts
  const storage = { async *list() { yield { key: `${badHex}/${gone}/orig.webp`, lastModifiedUtc: old }; }, async delete(key) { deleted.push(key); } };
  const result = await cleanOrphanObjects({ pool, storage, now, log: {} });
  assert.deepEqual(deleted, []);
  assert.equal(result.deleted, 0);
});
