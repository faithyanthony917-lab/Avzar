import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDesignCsv, commitDesignCsv } from '../src/auth/designCsvService.js';
import { bulkDesignOperation } from '../src/auth/designService.js';

const user = { businessId: '00000000-0000-4000-8000-000000000002', userId: '00000000-0000-4000-8000-000000000001', isOwner: true, permissions: [] };
const csv = [
  'Name,Description,Kind,Category,Garment Type,Base price,Production days,Featured,Tags,Fabrics,Colours,Sizes',
  'Classic Kaftan,Simple cut,MadeToOrder,,Kaftan,25000.00,7,yes,"formal; men",cotton,"navy; black",S;M;L',
  'Classic Kaftan,Duplicate,MadeToOrder,,Kaftan,25000,7,no,,,,',
  'Broken Price,Invalid,MadeToOrder,,Dress,abc,7,no,,,,',
].join('\n');

function previewPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('FROM "DesignCategories"')) return { rows: [] };
      if (sql.includes('FROM "Designs"')) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('design CSV preview reports row-level invalid and duplicate rows, scoped to the current business', async () => {
  const pool = previewPool();
  const result = await previewDesignCsv(pool, user, csv);
  assert.equal(result.totalRows, 3);
  assert.equal(result.validRows, 1);
  assert.equal(result.duplicateRows, 1);
  assert.equal(result.invalidRows, 1);
  assert.equal(result.problems.find((row) => row.outcome === 'Duplicate')?.row, 3);
  assert.match(result.problems.find((row) => row.outcome === 'Invalid')?.message ?? '', /Base price/);
  assert.equal(result.problems.find((row) => row.outcome === 'Invalid')?.field, 'basePrice');
  assert.ok(pool.calls.every((call) => call.values[0] === user.businessId));
});

test('design CSV commit rejection returns row, field, and message details', async () => {
  const pool = previewPool();
  const preview = await previewDesignCsv(pool, user, csv);
  await assert.rejects(
    () => commitDesignCsv(pool, user, csv, { expectedHash: preview.fileHash, skipInvalidRows: false }),
    (error) => error.code === 'invalid_rows' && error.extensions.rowErrors[0].row === 4 && error.extensions.rowErrors[0].field === 'basePrice' && Boolean(error.extensions.rowErrors[0].message),
  );
});

test('design CSV commit rejects a file that differs from the preview hash', async () => {
  const pool = previewPool();
  await assert.rejects(() => commitDesignCsv(pool, user, csv, { expectedHash: 'not-the-hash', skipInvalidRows: true }), (error) => error.code === 'file_changed');
  assert.equal(pool.calls.length, 0);
});

test('bulk design operations reject IDs outside the active business without updating any rows', async () => {
  const queries = [];
  const pool = {
    connect: async () => ({
      query: async (sql, values = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT "Id","Status","Visibility" FROM "Designs"')) return { rows: [] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
  await assert.rejects(() => bulkDesignOperation(pool, user, {
    ids: ['00000000-0000-4000-8000-000000000099'], action: 'status', status: 'Archived',
  }), (error) => error.code === 'design_not_found');
  assert.equal(queries.some((call) => call.sql.includes('UPDATE "Designs"')), false);
  const scopedRead = queries.find((call) => call.sql.includes('SELECT "Id","Status","Visibility" FROM "Designs"'));
  assert.equal(scopedRead.values[0], user.businessId);
});

function writableDesignPool() {
  const designs = [];
  const businessId = user.businessId;
  async function query(sql, values = []) {
    if (sql.includes('SELECT "Id","Name" FROM "DesignCategories"')) return { rows: [] };
    if (sql.includes('SELECT lower(trim("Name")) AS "Name" FROM "Designs"')) return { rows: designs.filter((row) => row.BusinessId === values[0]).map((row) => ({ Name: row.Name.toLowerCase() })) };
    if (sql.includes('SELECT "CurrencyCode" FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN' }] };
    if (sql.includes('FROM "Designs" d') && sql.includes('WHERE d."BusinessId" = $1 AND d."Id" = $2')) {
      const row = designs.find((item) => item.BusinessId === values[0] && item.Id === values[1]);
      return { rows: row ? [{ ...row, CategoryName: null, Version: '1', CreatedAtUtc: new Date('2026-01-01T00:00:00.000Z') }] : [] };
    }
    if (sql.includes('FROM "DesignImages"')) return { rows: [] };
    return { rows: [] };
  }
  return {
    designs,
    query,
    connect: async () => ({
      query: async (sql, values = []) => {
        if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: '100' }] };
        if (sql.includes('count(*)::int AS "Count" FROM "Designs"')) return { rows: [{ Count: designs.filter((row) => row.BusinessId === values[0] && row.Status === 'Active').length }] };
        if (sql.includes('SELECT "Slug" FROM "Designs"')) return { rows: designs.filter((row) => row.BusinessId === values[0]).map((row) => ({ Slug: row.Slug })) };
        if (sql.includes('INSERT INTO "Designs"')) {
          designs.push({ Id: values[0], BusinessId: values[1], Name: values[2], Slug: values[3], Description: values[4], Kind: values[5], CategoryId: values[6], GarmentType: values[7], Tags: values[8], Fabrics: values[9], Colours: values[10], Sizes: values[11], BasePrice: values[12], CurrencyCode: values[13], ProductionDays: values[14], IsFeatured: values[15], Visibility: 'Private', Status: 'Active', ParentDesignId: values[16] });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
}

test('design CSV commit creates valid rows and reports skipped duplicates and invalid rows', async () => {
  const pool = writableDesignPool();
  const { createHash } = await import('node:crypto');
  const result = await commitDesignCsv(pool, user, csv, { expectedHash: createHash('sha256').update(csv, 'utf8').digest('hex').toUpperCase(), skipInvalidRows: true });
  assert.deepEqual([result.created, result.skipped, result.failed], [1, 1, 1]);
  assert.equal(pool.designs.length, 1);
  assert.equal(pool.designs[0].BusinessId, user.businessId);
  assert.equal(pool.designs[0].Visibility, 'Private');
  assert.equal(result.rows.find((row) => row.outcome === 'Invalid')?.row, 4);
});

test('design CSV preview preserves every row error for the maximum-size import', async () => {
  const rows = Array.from({ length: 301 }, () => { const row = Array(12).fill(''); row[2] = 'MadeToOrder'; return row.join(','); });
  const result = await previewDesignCsv(previewPool(), user, [csv.split('\n')[0], ...rows].join('\n'));
  assert.equal(result.totalRows, 301);
  assert.equal(result.problems.length, 301);
});

test('design CSV reports an unknown category against the category field even when its name contains other field words', async () => {
  const pool = previewPool();
  const input = ['Name,Category', 'Plain Shirt,Name Kind Group'].join('\n');
  const result = await previewDesignCsv(pool, user, input);
  assert.equal(result.invalidRows, 1);
  assert.equal(result.problems[0].outcome, 'Invalid');
  assert.equal(result.problems[0].field, 'category');
  assert.match(result.problems[0].message, /does not exist in this business/);
});
