import { createHash, timingSafeEqual } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { AppError } from '../http/errors.js';
import { createDesign } from './designService.js';

const hashCsv = (csv) => createHash('sha256').update(csv, 'utf8').digest('hex').toUpperCase();
const normalizeHeader = (value) => String(value ?? '').trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
const cleanCell = (value) => String(value ?? '').replace(/^([=+\-@\t\r])/, "'$1").trim();
const listCell = (value) => String(value ?? '').split(';').map((part) => cleanCell(part)).filter(Boolean);
const truthy = new Set(['yes', 'true', '1']);
const falsy = new Set(['no', 'false', '0', '']);

function parseRows(csv) {
  if (Buffer.byteLength(csv, 'utf8') > 5 * 1024 * 1024) throw AppError.badRequest('file_too_large', 'CSV must be under 5 MB.');
  let records;
  try {
    records = parseCsv(csv, { bom: true, skip_empty_lines: true, relax_quotes: false, relax_column_count: false, max_record_size: 32_000 });
  } catch {
    throw AppError.badRequest('csv_malformed', 'The CSV is malformed. Check quoted values and try again.');
  }
  if (records.length < 2) throw AppError.badRequest('csv_empty', 'CSV needs a header and at least one design row.');
  const headers = new Map();
  records[0].forEach((heading, index) => {
    const key = normalizeHeader(heading);
    if (key && !headers.has(key)) headers.set(key, index);
  });
  if (!headers.has('name')) throw AppError.badRequest('csv_missing_column', "CSV is missing the required 'Name' column.");
  if (records.length > 5001) throw AppError.badRequest('too_many_rows', 'Import up to 5,000 design rows at a time.');
  return records.slice(1).map((record, index) => {
    const get = (name) => cleanCell(record[headers.get(normalizeHeader(name))] ?? '');
    const name = get('name');
    const description = get('description');
    const kindRaw = get('kind') || 'MadeToOrder';
    const kinds = new Map([['readymade', 'ReadyMade'], ['madetoorder', 'MadeToOrder'], ['service', 'Service']]);
    const kind = kinds.get(normalizeHeader(kindRaw));
    const categoryName = get('category');
    const garmentType = get('garment type');
    const basePriceRaw = get('base price');
    const productionDaysRaw = get('production days');
    const featuredRaw = get('featured').toLowerCase();
    const tags = listCell(get('tags'));
    const fabrics = listCell(get('fabrics'));
    const colours = listCell(get('colours'));
    const sizes = listCell(get('sizes'));
    let error = null;
    if (name.length < 2 || name.length > 120) error = 'Name is required and must be 2–120 characters.';
    else if (description.length > 4000) error = 'Description must be at most 4,000 characters.';
    else if (!kind) error = 'Kind must be ReadyMade, MadeToOrder or Service.';
    else if (garmentType.length > 60) error = 'Garment Type must be at most 60 characters.';
    else if (basePriceRaw && (!/^(?:\d+)(?:\.\d{1,2})?$/.test(basePriceRaw) || Number(basePriceRaw) > 999_999_999.99)) error = 'Base price must be a non-negative amount with at most 2 decimal places.';
    else if (productionDaysRaw && (!/^\d+$/.test(productionDaysRaw) || Number(productionDaysRaw) < 1 || Number(productionDaysRaw) > 365)) error = 'Production days must be a whole number from 1 to 365.';
    else if (!truthy.has(featuredRaw) && !falsy.has(featuredRaw)) error = 'Featured must be yes/no, true/false or 1/0.';
    else if (tags.length > 20 || fabrics.length > 30 || colours.length > 30 || sizes.length > 30) error = 'Too many list values: tags allow 20; fabrics, colours and sizes allow 30 each.';
    return {
      row: index + 2, name, description: description || null, kind: kind ?? 'MadeToOrder', categoryName: categoryName || null,
      garmentType: garmentType || null, basePrice: basePriceRaw ? Number(basePriceRaw) : null,
      productionDays: productionDaysRaw ? Number(productionDaysRaw) : null, isFeatured: truthy.has(featuredRaw),
      tags, fabrics, colours, sizes, error, duplicate: false, categoryId: null,
    };
  });
}

async function analyzeDesignCsv(pool, user, csv) {
  const rows = parseRows(csv);
  const [categories, existing] = await Promise.all([
    pool.query('SELECT "Id","Name" FROM "DesignCategories" WHERE "BusinessId" = $1', [user.businessId]),
    pool.query('SELECT lower(trim("Name")) AS "Name" FROM "Designs" WHERE "BusinessId" = $1', [user.businessId]),
  ]);
  const categoryByName = new Map(categories.rows.map((category) => [String(category.Name).trim().toLowerCase(), category]));
  const existingNames = new Set(existing.rows.map((row) => row.Name));
  const seen = new Set();
  for (const row of rows) {
    if (row.error) continue;
    const key = row.name.trim().toLowerCase();
    if (seen.has(key) || existingNames.has(key)) {
      row.duplicate = true;
      row.error = null;
      continue;
    }
    seen.add(key);
    if (row.categoryName) {
      const category = categoryByName.get(row.categoryName.toLowerCase());
      if (!category) row.error = `Category '${row.categoryName}' does not exist in this business.`;
      else row.categoryId = category.Id;
    }
  }
  return rows;
}

function issueField(message) { const text = String(message ?? '').toLowerCase(); if (text.startsWith('category')) return 'category'; if (text.includes('name')) return 'name'; if (text.includes('description')) return 'description'; if (text.includes('kind')) return 'kind'; if (text.includes('category')) return 'category'; if (text.includes('garment type')) return 'garmentType'; if (text.includes('base price')) return 'basePrice'; if (text.includes('production days')) return 'productionDays'; if (text.includes('featured')) return 'featured'; if (text.includes('list values')) return 'tags/fabrics/colours/sizes'; return null; }
function resultRow(row, outcome, message = null) {
  return { row: row.row, field: issueField(message), name: row.name || null, outcome, message };
}

export async function previewDesignCsv(pool, user, csv) {
  const rows = await analyzeDesignCsv(pool, user, csv);
  const items = rows.map((row) => resultRow(row, row.error ? 'Invalid' : row.duplicate ? 'Duplicate' : 'Create', row.error ?? (row.duplicate ? 'A design with this name already exists or repeats in this file.' : null)));
  return {
    fileHash: hashCsv(csv), totalRows: rows.length,
    validRows: items.filter((row) => row.outcome === 'Create').length,
    duplicateRows: items.filter((row) => row.outcome === 'Duplicate').length,
    invalidRows: items.filter((row) => row.outcome === 'Invalid').length,
    problems: items.filter((row) => row.outcome !== 'Create'),
  };
}

export async function commitDesignCsv(pool, user, csv, { expectedHash, skipInvalidRows }) {
  const actualHash = hashCsv(csv);
  const expected = Buffer.from(String(expectedHash ?? '').toUpperCase());
  const actual = Buffer.from(actualHash);
  if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw AppError.conflict('file_changed', 'The CSV differs from the preview. Preview the current file again.');
  }
  const rows = await analyzeDesignCsv(pool, user, csv);
  if (!skipInvalidRows && rows.some((row) => row.error)) {
    const rowErrors = rows.filter((row) => row.error).map((row) => resultRow(row, 'Invalid', row.error));
    throw AppError.conflict('invalid_rows', 'The file has invalid rows. Fix them or explicitly choose to skip invalid rows.', { rowErrors });
  }
  const results = [];
  let created = 0; let skipped = 0; let failed = 0;
  for (const row of rows) {
    if (row.error) { failed += 1; results.push(resultRow(row, 'Invalid', row.error)); continue; }
    if (row.duplicate) { skipped += 1; results.push(resultRow(row, 'Skipped', 'A design with this name already exists or repeats in this file.')); continue; }
    try {
      await createDesign(pool, user, {
        name: row.name, description: row.description, kind: row.kind, categoryId: row.categoryId,
        garmentType: row.garmentType, basePrice: row.basePrice, productionDays: row.productionDays,
        isFeatured: row.isFeatured, tags: row.tags, fabrics: row.fabrics, colours: row.colours, sizes: row.sizes,
      });
      created += 1;
      results.push(resultRow(row, 'Created'));
    } catch (error) {
      failed += 1;
      const safeMessage = error?.status >= 400 && error?.status < 500 ? error.message : 'The design could not be imported. Review the row and try again.';
      results.push(resultRow(row, 'Failed', safeMessage));
    }
  }
  return { created, skipped, failed, rows: results };
}
