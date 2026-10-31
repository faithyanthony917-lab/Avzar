import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCollectionCsv } from '../src/auth/collectionCsvService.js';

const user = { businessId: 'business-1' };

test('collection CSV preview validates rows and reports duplicate names per business', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ Name: 'existing collection' }] };
  } };
  const csv = 'Name,Description,Visibility,Sort Order\nSummer,Seasonal,Public,1\nExisting collection,,Private,0\nSummer,,Private,2\nX,,Private,-1\n';
  const result = await previewCollectionCsv(pool, user, csv);
  assert.equal(result.totalRows, 4);
  assert.equal(result.validRows, 1);
  assert.equal(result.duplicateRows, 2);
  assert.equal(result.invalidRows, 1);
  assert.deepEqual(result.problems.map((row) => row.row), [3, 4, 5]);
  assert.equal(result.problems.find((row) => row.outcome === 'Invalid')?.field, 'sortOrder');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ['business-1']);
  assert.ok(calls[0].sql.includes('"BusinessId" = $1'));
});

test('collection CSV preview requires a Name header', async () => {
  await assert.rejects(
    () => previewCollectionCsv({ query: async () => ({ rows: [] }) }, user, 'Description,Visibility\nHello,Public\n'),
    (error) => error.code === 'csv_missing_column',
  );
});

test('collection CSV preview rejects malformed CSV', async () => {
  await assert.rejects(
    () => previewCollectionCsv({ query: async () => ({ rows: [] }) }, user, 'Name,Description\n"Summer,unterminated\n'),
    (error) => error.code === 'csv_malformed',
  );
});

// ---- commit behaviour -------------------------------------------------------------------------
import { commitCollectionCsv } from '../src/auth/collectionCsvService.js';

const commitCsv = 'Name,Description,Visibility,Sort Order\nSummer,Seasonal,Public,1\nExisting collection,,Private,0\nSummer,,Private,2\nX,,Private,-1\nWinter,,Private,3\n';
const existingPool = (calls = []) => ({ query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ Name: 'existing collection' }] }; } });
const hashOf = async (pool) => (await previewCollectionCsv(pool, user, commitCsv)).fileHash;

test('collection CSV preview exposes fileHash and per-row outcome keys used by the web UI', async () => {
  const preview = await previewCollectionCsv(existingPool(), user, commitCsv);
  assert.match(preview.fileHash, /^[0-9A-F]{64}$/);
  assert.equal(preview.hash, undefined);
  assert.deepEqual(preview.problems.map((row) => row.outcome), ['Duplicate', 'Duplicate', 'Invalid']);
  assert.equal(preview.problems.find((row) => row.outcome === 'Invalid')?.field, 'sortOrder');
});

test('collection CSV commit creates valid rows and reports every other row', async () => {
  const created = [];
  const pool = existingPool();
  const result = await commitCollectionCsv(pool, user, commitCsv,
    { expectedHash: await hashOf(pool), skipInvalidRows: true },
    { createCollection: async (_pool, actor, input) => { created.push({ actor, input }); } });
  assert.equal(result.created, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.rows.map((row) => [row.row, row.outcome]), [[2, 'Created'], [3, 'Skipped'], [4, 'Skipped'], [5, 'Invalid'], [6, 'Created']]);
  assert.deepEqual(created.map((entry) => entry.input.name), ['Summer', 'Winter']);
  assert.ok(created.every((entry) => entry.actor === user));
  assert.equal(created[0].input.visibility, 'Public');
  assert.equal(created[0].input.sortOrder, 1);
});

test('collection CSV commit refuses invalid rows unless the user chose to skip them', async () => {
  const pool = existingPool();
  const expectedHash = await hashOf(pool);
  let calls = 0;
  await assert.rejects(
    () => commitCollectionCsv(pool, user, commitCsv, { expectedHash, skipInvalidRows: false },
      { createCollection: async () => { calls += 1; } }),
    (error) => error.code === 'invalid_rows',
  );
  assert.equal(calls, 0);
});

test('collection CSV commit rejection returns row, field, and message details', async () => {
  const pool = existingPool();
  const preview = await previewCollectionCsv(pool, user, commitCsv);
  await assert.rejects(
    () => commitCollectionCsv(pool, user, commitCsv, { expectedHash: preview.fileHash, skipInvalidRows: false }),
    (error) => error.code === 'invalid_rows' && error.extensions.rowErrors[0].row === 5 && error.extensions.rowErrors[0].field === 'sortOrder' && Boolean(error.extensions.rowErrors[0].message),
  );
});

test('collection CSV commit rejects a missing or stale hash before touching the database', async () => {
  const pool = existingPool();
  for (const expectedHash of [undefined, '', 'ABC', 'A'.repeat(64)]) {
    await assert.rejects(
      () => commitCollectionCsv(pool, user, commitCsv, { expectedHash, skipInvalidRows: true }, { createCollection: async () => {} }),
      (error) => error.code === 'csv_changed',
    );
  }
});

test('collection CSV commit records a failed row with a safe message and keeps going', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const csv = 'Name\nAlpha\nBeta\nGamma\n';
  const hash = (await previewCollectionCsv(pool, user, csv)).fileHash;
  let n = 0;
  const result = await commitCollectionCsv(pool, user, csv, { expectedHash: hash, skipInvalidRows: true }, {
    createCollection: async () => {
      n += 1;
      if (n === 2) throw Object.assign(new Error('Collection limit reached.'), { status: 403 });
      if (n === 3) throw new Error('connection to 10.0.0.5 refused');
    },
  });
  assert.deepEqual(result.rows.map((row) => row.outcome), ['Created', 'Failed', 'Failed']);
  assert.equal(result.rows[1].message, 'Collection limit reached.');
  assert.doesNotMatch(result.rows[2].message, /10\.0\.0\.5/);
  assert.equal(result.created, 1);
  assert.equal(result.failed, 2);
});

test('collection CSV duplicate check only reads the current business', async () => {
  const calls = [];
  const expectedHash = await hashOf(existingPool());
  await commitCollectionCsv(existingPool(calls), { businessId: 'business-2' }, commitCsv,
    { expectedHash, skipInvalidRows: true }, { createCollection: async () => {} });
  assert.ok(calls.every((call) => call.values[0] === 'business-2' && call.sql.includes('"BusinessId" = $1')));
});
