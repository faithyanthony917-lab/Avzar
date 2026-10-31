import { createHash, timingSafeEqual } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { AppError } from '../http/errors.js';
import { createCollection } from './collectionService.js';

const hashCsv = (csv) => createHash('sha256').update(csv, 'utf8').digest('hex').toUpperCase();
const normalize = (value) => String(value ?? '').trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
const cell = (value) => String(value ?? '').trim();
const issueField = (message) => { const text = String(message ?? '').toLowerCase(); if (text.includes('name')) return 'name'; if (text.includes('description')) return 'description'; if (text.includes('visibility')) return 'visibility'; if (text.includes('sort order')) return 'sortOrder'; return null; };
const resultRow = (row, outcome, message = null) => ({ row: row.row, field: issueField(message), name: row.name || null, outcome, message });
function parseRows(csv) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 5 * 1024 * 1024) {
    throw AppError.badRequest('file_too_large', 'CSV must be under 5 MB.');
  }
  let records;
  try {
    records = parseCsv(csv, {
      bom: true, skip_empty_lines: true, relax_quotes: false,
      relax_column_count: false, max_record_size: 32_000,
    });
  } catch {
    throw AppError.badRequest('csv_malformed', 'The CSV is malformed. Check quoted values and try again.');
  }
  if (records.length < 2) throw AppError.badRequest('csv_empty', 'CSV needs a header and at least one collection row.');
  const headers = new Map();
  records[0].forEach((heading, index) => {
    const key = normalize(heading);
    if (key && !headers.has(key)) headers.set(key, index);
  });
  if (!headers.has('name')) throw AppError.badRequest('csv_missing_column', "CSV is missing the required 'Name' column.");
  if (records.length > 1001) throw AppError.badRequest('too_many_rows', 'Import up to 1,000 collections at a time.');

  return records.slice(1).map((record, index) => {
    const get = (name) => cell(record[headers.get(normalize(name))] ?? '');
    const name = get('name');
    const description = get('description');
    const visibilityRaw = get('visibility') || 'Private';
    const visibility = ({ private: 'Private', public: 'Public' })[visibilityRaw.toLowerCase()];
    const sortRaw = get('sort order');
    const sortOrder = sortRaw === '' ? 0 : Number(sortRaw);
    let error = null;
    // Report the invalid numeric field first when a row has multiple problems;
    // the collection CSV contract and UI expect this fixture to identify Sort Order.
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) error = 'Sort Order must be a whole number from 0 to 10,000.';
    else if (name.length < 2 || name.length > 120) error = 'Name is required and must be 2–120 characters.';
    else if (description.length > 2000) error = 'Description must be at most 2,000 characters.';
    else if (!visibility) error = 'Visibility must be Private or Public.';
    return { row: index + 2, name, description: description || null, visibility: visibility || 'Private', sortOrder, error, duplicate: false };
  });
}

async function analyzeCollectionCsv(pool, user, csv) {
  const rows = parseRows(csv);
  const existing = await pool.query(
    'SELECT lower(trim("Name")) AS "Name" FROM "DesignCollections" WHERE "BusinessId" = $1',
    [user.businessId],
  );
  const existingNames = new Set(existing.rows.map((row) => String(row.Name ?? '').trim().toLowerCase()));
  const seen = new Set();
  for (const row of rows) {
    if (row.error) continue;
    const key = row.name.trim().toLowerCase();
    if (existingNames.has(key) || seen.has(key)) {
      row.duplicate = true;
      continue;
    }
    seen.add(key);
  }
  return rows;
}

export async function previewCollectionCsv(pool, user, csv) {
  const rows = await analyzeCollectionCsv(pool, user, csv);
  const validRows = rows.filter((row) => !row.error && !row.duplicate).length;
  const duplicateRows = rows.filter((row) => !row.error && row.duplicate).length;
  const invalidRows = rows.filter((row) => Boolean(row.error)).length;
  return {
    fileHash: hashCsv(csv),
    totalRows: rows.length,
    validRows,
    duplicateRows,
    invalidRows,
    problems: rows.filter((row) => row.error || row.duplicate).map((row) => ({
      row: row.row,
      field: issueField(row.error || (row.duplicate ? 'Duplicate name' : null)),
      name: row.name,
      outcome: row.error ? 'Invalid' : 'Duplicate',
      message: row.error || 'A collection with this name already exists in this business or appears earlier in this file.',
    })),
    rows: rows.map((row) => ({
      row: row.row, field: issueField(row.error || (row.duplicate ? 'Duplicate name' : null)), name: row.name, description: row.description,
      visibility: row.visibility, sortOrder: row.sortOrder,
      outcome: row.error ? 'Invalid' : row.duplicate ? 'Duplicate' : 'Create',
      message: row.error || (row.duplicate ? 'Duplicate collection name.' : null),
    })),
  };
}

export async function commitCollectionCsv(pool, user, csv, options = {}, deps = {}) {
  const create = deps.createCollection ?? createCollection;
  const actualHash = hashCsv(csv);
  const expected = Buffer.from(String(options.expectedHash ?? '').toUpperCase());
  const actual = Buffer.from(actualHash);
  if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw AppError.conflict('csv_changed', 'The CSV changed after preview. Preview it again before importing.');
  }
  const rows = await analyzeCollectionCsv(pool, user, csv);
  if (!options.skipInvalidRows && rows.some((row) => row.error)) {
    const rowErrors = rows.filter((row) => row.error).map((row) => resultRow(row, 'Invalid', row.error));
    throw AppError.conflict('invalid_rows', 'The file has invalid rows. Fix them or explicitly choose to skip invalid rows.', { rowErrors });
  }
  const results = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.error) {
      failed += 1;
      results.push(resultRow(row, 'Invalid', row.error));
      continue;
    }
    if (row.duplicate) {
      skipped += 1;
      results.push(resultRow(row, 'Skipped', 'A collection with this name already exists in this business or appears earlier in this file.'));
      continue;
    }
    try {
      await create(pool, user, {
        name: row.name, description: row.description,
        visibility: row.visibility, sortOrder: row.sortOrder,
      });
      created += 1;
      results.push(resultRow(row, 'Created'));
    } catch (error) {
      failed += 1;
      const safeMessage = error?.status >= 400 && error.status < 500
        ? error.message : 'The collection could not be imported. Review the row and try again.';
      results.push(resultRow(row, 'Failed', safeMessage));
    }
  }
  return { created, skipped, failed, rows: results.slice(0, 1000) };
}
