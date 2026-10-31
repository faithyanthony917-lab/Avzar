import test from 'node:test';
import assert from 'node:assert/strict';
import { commitCustomerImport, previewCustomerImport } from '../src/auth/customerImportService.js';

test('customer CSV preview preserves every row error instead of truncating the report', async () => {
  const csv = ['Full name,Email', ...Array.from({ length: 301 }, () => ',bad-email')].join('\n');
  const pool = { query: async () => ({ rows: [] }) };
  const user = { businessId: '00000000-0000-4000-8000-000000000002' };
  const result = await previewCustomerImport(pool, user, csv);
  assert.equal(result.totalRows, 301);
  assert.equal(result.problems.length, 301);
});


test('customer CSV commit rejection returns row, field, and message details', async () => {
  const csv = 'Full name,Email\n,not-an-email\n';
  const pool = { query: async () => ({ rows: [] }) };
  const user = { businessId: '00000000-0000-4000-8000-000000000002', userId: '00000000-0000-4000-8000-000000000001' };
  const preview = await previewCustomerImport(pool, user, csv);
  await assert.rejects(
    () => commitCustomerImport(pool, user, csv, { expectedHash: preview.fileHash, skipInvalidRows: false }),
    (error) => error.code === 'import_has_errors' && error.extensions.rowErrors[0].row === 2 && error.extensions.rowErrors[0].field === 'fullName' && Boolean(error.extensions.rowErrors[0].message),
  );
});
