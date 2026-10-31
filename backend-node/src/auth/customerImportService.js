import { createHash, randomUUID } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { AppError } from '../http/errors.js';
import { ensureBelowLimit } from './entitlementService.js';

export const CUSTOMER_CSV_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_EXPORT_ROWS = 50_000;
const headerAliases = new Map([
  ['full name', 'name'], ['fullname', 'name'], ['name', 'name'], ['customer', 'name'], ['customer name', 'name'],
  ['email', 'email'], ['e-mail', 'email'], ['email address', 'email'], ['phone', 'phone'], ['mobile', 'phone'],
  ['telephone', 'phone'], ['tel', 'phone'], ['phone number', 'phone'], ['address', 'address'], ['address line', 'address'],
  ['city', 'city'], ['town', 'city'], ['notes', 'notes'], ['note', 'notes'], ['garment preferences', 'preferences'], ['preferences', 'preferences'],
]);

const normalizeEmail = (value) => value?.trim().toLowerCase() || null;
const normalizePhone = (value) => value?.replace(/\D/g, '') || null;
const asText = (value) => value == null || value === '' ? null : String(value);
const sha = (csv) => createHash('sha256').update(csv, 'utf8').digest('hex');

function csvRows(csv) {
  try {
    return parseCsv(csv, { bom: true, skip_empty_lines: true, relax_quotes: false, relax_column_count: true, record_delimiter: ['\r\n', '\n', '\r'] });
  } catch {
    throw AppError.badRequest('csv_malformed', 'The CSV is malformed.');
  }
}

function unguard(value) {
  return value.length > 1 && value[0] === "'" && '=+-@'.includes(value[1]) ? value.slice(1) : value;
}

function validateRow(rowNumber, cells, mapping) {
  const values = {};
  for (const [column, key] of mapping) values[key] = unguard(String(cells[column] ?? '').trim());
  const name = values.name || null;
  const email = values.email || null;
  const phone = values.phone || null;
  const address = values.address || null;
  const city = values.city || null;
  const notes = values.notes || null;
  const preferences = values.preferences || null;
  const error = !name || name.length < 2 || name.length > 120 ? 'Full name must be 2-120 characters.'
    : email && (email.length > 256 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ? 'Email is not valid.'
      : phone && (phone.length > 40 || !normalizePhone(phone)) ? 'Phone must contain digits and be at most 40 characters.'
        : address && address.length > 300 ? 'Address is longer than 300 characters.'
          : city && city.length > 100 ? 'City is longer than 100 characters.'
            : notes && notes.length > 4000 ? 'Notes are longer than 4000 characters.'
              : preferences && preferences.length > 2000 ? 'Garment preferences are longer than 2000 characters.' : null;
  return {
    row: rowNumber, request: error ? null : { fullName: name, email, phone, addressLine: address, city, notes, garmentPreferences: preferences },
    error, normalizedEmail: error ? null : normalizeEmail(email), normalizedPhone: error ? null : normalizePhone(phone),
  };
}

function parseCustomers(csv) {
  const rows = csvRows(csv);
  if (!rows.length) throw AppError.badRequest('csv_empty', 'The file is empty.');
  if (rows.length === 1) throw AppError.badRequest('csv_no_rows', 'The file has a header but no customers.');
  if (rows.length - 1 > MAX_ROWS) throw AppError.badRequest('too_many_rows', `Import at most ${MAX_ROWS} customers at a time.`);
  const mapping = new Map();
  const unknownColumns = [];
  (rows[0] ?? []).forEach((raw, index) => {
    const header = String(raw ?? '').trim();
    if (!header) return;
    const key = headerAliases.get(header.toLowerCase());
    if (!key || [...mapping.values()].includes(key)) unknownColumns.push(header);
    else mapping.set(index, key);
  });
  if (![...mapping.values()].includes('name')) throw AppError.badRequest('csv_missing_name_column', 'The first row must have a "Full name" column.');
  return {
    unknownColumns,
    rows: rows.slice(1).map((cells, index) => validateRow(index + 2, cells, mapping)),
  };
}

async function classifyRows(db, businessId, parsed) {
  const emails = [...new Set(parsed.rows.map((row) => row.normalizedEmail).filter(Boolean))];
  const phones = [...new Set(parsed.rows.map((row) => row.normalizedPhone).filter(Boolean))];
  const existing = emails.length || phones.length ? (await db.query(`SELECT "Id", "NormalizedEmail", "NormalizedPhone" FROM "Customers"
    WHERE "BusinessId" = $1 AND "Status" <> 'Merged'
      AND ((cardinality($2::text[]) > 0 AND "NormalizedEmail" = ANY($2::text[]))
        OR (cardinality($3::text[]) > 0 AND "NormalizedPhone" = ANY($3::text[])))`, [businessId, emails, phones])).rows : [];
  const seenEmails = new Set();
  const seenPhones = new Set();
  return parsed.rows.map((row) => {
    if (row.error) return { ...row, outcome: 'invalid', message: row.error, existingId: null };
    if ((row.normalizedEmail && seenEmails.has(row.normalizedEmail)) || (row.normalizedPhone && seenPhones.has(row.normalizedPhone))) {
      return { ...row, outcome: 'duplicate_in_file', message: 'Same email or phone as an earlier row in this file.', existingId: null };
    }
    if (row.normalizedEmail) seenEmails.add(row.normalizedEmail);
    if (row.normalizedPhone) seenPhones.add(row.normalizedPhone);
    const byEmail = row.normalizedEmail ? existing.find((item) => item.NormalizedEmail === row.normalizedEmail) : null;
    const byPhone = row.normalizedPhone ? existing.find((item) => item.NormalizedPhone === row.normalizedPhone) : null;
    if (byEmail && byPhone && byEmail.Id !== byPhone.Id) return { ...row, outcome: 'invalid', message: 'The email and the phone belong to two different existing customers. Merge them first.', existingId: null };
    const match = byEmail ?? byPhone;
    return match ? { ...row, outcome: 'duplicate', message: 'Matches an existing customer.', existingId: match.Id }
      : { ...row, outcome: 'create', message: null, existingId: null };
  });
}

async function analyze(pool, businessId, csv) {
  const parsed = parseCustomers(csv);
  return { hash: sha(csv), parsed, classified: await classifyRows(pool, businessId, parsed) };
}

function issueField(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.includes('full name')) return 'fullName'; if (text.includes('email')) return 'email'; if (text.includes('phone')) return 'phone';
  if (text.includes('address')) return 'address'; if (text.includes('city')) return 'city'; if (text.includes('notes')) return 'notes'; if (text.includes('garment preferences')) return 'garmentPreferences';
  return text.includes('same email or phone') || text.includes('matches an existing') ? 'email/phone' : null;
}
function rowResult(row, outcome, message = row.message) {
  return { row: row.row, field: issueField(message), outcome, message, fullName: row.request?.fullName ?? null, existingCustomerId: row.existingId ?? null };
}

export async function previewCustomerImport(pool, user, csv) {
  const { hash, parsed, classified } = await analyze(pool, user.businessId, csv);
  return {
    fileHash: hash, totalRows: classified.length,
    newCount: classified.filter((row) => row.outcome === 'create').length,
    existingCount: classified.filter((row) => row.outcome === 'duplicate').length,
    duplicateInFileCount: classified.filter((row) => row.outcome === 'duplicate_in_file').length,
    invalidCount: classified.filter((row) => row.outcome === 'invalid').length,
    unknownColumns: parsed.unknownColumns,
    sampleNew: classified.filter((row) => row.outcome === 'create').slice(0, 10).map((row) => row.request.fullName),
    problems: classified.filter((row) => row.outcome !== 'create').map((row) => rowResult(row)),
  };
}

function cell(value) {
  if (value == null || value === '') return '';
  let text = String(value).replaceAll('\0', '');
  if ('=+-@\t\r'.includes(text[0])) text = `'${text}`;
  if (/[,"\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export async function exportCustomers(pool, user) {
  const { rows } = await pool.query(`SELECT "FullName", "Email", "Phone", "AddressLine", "City", "Notes", "GarmentPreferences", "Status", "CreatedAtUtc"
    FROM "Customers" WHERE "BusinessId" = $1 AND "Status" <> 'Merged' ORDER BY "FullName" LIMIT $2`, [user.businessId, MAX_EXPORT_ROWS]);
  const values = [['Full name', 'Email', 'Phone', 'Address', 'City', 'Notes', 'Garment preferences', 'Status', 'Created (UTC)']];
  for (const row of rows) values.push([row.FullName, row.Email, row.Phone, row.AddressLine, row.City, row.Notes,
    row.GarmentPreferences, row.Status, new Date(row.CreatedAtUtc).toISOString().replace(/\.\d{3}Z$/, 'Z')]);
  return `\uFEFF${values.map((line) => line.map(cell).join(',')).join('\r\n')}\r\n`;
}

export async function commitCustomerImport(pool, user, csv, options) {
  const mode = String(options.onDuplicate ?? '').toLowerCase();
  if (!['', 'skip', 'update'].includes(mode)) throw AppError.badRequest('invalid_on_duplicate', 'OnDuplicate must be skip or update.');
  const update = mode === 'update';
  const initial = await analyze(pool, user.businessId, csv);
  if (initial.hash.toLowerCase() !== String(options.expectedHash ?? '').toLowerCase()) {
    throw AppError.conflict('file_changed', 'This is not the file you previewed. Preview it again before importing.');
  }
  const invalidCount = initial.classified.filter((row) => row.outcome === 'invalid').length;
  if (invalidCount && !options.skipInvalidRows) throw new AppError(400, 'import_has_errors', `${invalidCount} row(s) have errors. Fix the file, or choose to skip invalid rows.`, { invalidRows: invalidCount, rowErrors: initial.classified.filter((row) => row.outcome === 'invalid').map((row) => rowResult(row, 'invalid')) });
  const duplicateCount = initial.classified.filter((row) => row.outcome === 'duplicate').length;
  if (update && duplicateCount && Number(options.confirmUpdateCount) !== duplicateCount) {
    throw AppError.conflict('confirmation_required', `This import would overwrite ${duplicateCount} existing customer(s). Confirm that number to continue.`, { updateCount: duplicateCount });
  }

  return withAtomicImport(pool, async (client) => {
    for (const row of initial.classified) {
      for (const key of [row.normalizedEmail && `email:${row.normalizedEmail}`, row.normalizedPhone && `phone:${row.normalizedPhone}`].filter(Boolean).sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
      }
    }
    const fresh = await classifyRows(client, user.businessId, initial.parsed);
    if (fresh.some((row, index) => row.outcome !== initial.classified[index].outcome || row.existingId !== initial.classified[index].existingId)) {
      throw AppError.conflict('import_changed', 'Customer records changed after preview. Preview the file again before importing.');
    }

    let created = 0, updated = 0, skipped = 0;
    const problems = [];
    for (const row of fresh) {
      if (row.outcome === 'invalid' || row.outcome === 'duplicate_in_file') {
        skipped += 1;
        problems.push(rowResult(row));
        continue;
      }
      if (row.outcome === 'duplicate' && !update) {
        skipped += 1;
        problems.push(rowResult(row, 'duplicate', 'Skipped: already exists.'));
        continue;
      }
      if (row.outcome === 'create') {
        await ensureBelowLimit(client, user.businessId, 'customers.active.max', async (db) => {
          const { rows } = await db.query(`SELECT count(*)::bigint AS "Count" FROM "Customers" WHERE "BusinessId" = $1 AND "Status" = 'Active'`, [user.businessId]);
          return Number(rows[0]?.Count ?? 0);
        });
        const customerId = randomUUID();
        await client.query(`INSERT INTO "Customers" ("Id", "BusinessId", "FullName", "Email", "NormalizedEmail", "Phone", "NormalizedPhone",
          "AddressLine", "City", "Notes", "GarmentPreferences", "Status", "CreatedAtUtc")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Active', now())`,
        [customerId, user.businessId, row.request.fullName, row.request.email, row.normalizedEmail, row.request.phone, row.normalizedPhone,
          row.request.addressLine, row.request.city, row.request.notes, row.request.garmentPreferences]);
        await client.query(`INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "EntityId", "EntityType")
          VALUES ($1, 'customer.created', $2, $3, now(), $4, 'Customer')`, [randomUUID(), user.userId, user.businessId, customerId]);
        created += 1;
      } else {
        const { rows: locked } = await client.query(`SELECT xmin::text::bigint AS "Version" FROM "Customers"
          WHERE "BusinessId" = $1 AND "Id" = $2 AND "Status" <> 'Merged' FOR UPDATE`, [user.businessId, row.existingId]);
        if (!locked[0]) throw AppError.conflict('import_changed', 'A customer changed after preview. Preview the file again before importing.');
        const { rowCount } = await client.query(`UPDATE "Customers" SET "FullName" = $1,
          "Email" = COALESCE($2, "Email"), "NormalizedEmail" = COALESCE($3, "NormalizedEmail"),
          "Phone" = COALESCE($4, "Phone"), "NormalizedPhone" = COALESCE($5, "NormalizedPhone"),
          "AddressLine" = COALESCE($6, "AddressLine"), "City" = COALESCE($7, "City"),
          "Notes" = COALESCE($8, "Notes"), "GarmentPreferences" = COALESCE($9, "GarmentPreferences"), "UpdatedAtUtc" = now()
          WHERE "BusinessId" = $10 AND "Id" = $11 AND xmin = $12::xid`,
        [row.request.fullName, row.request.email, row.normalizedEmail, row.request.phone, row.normalizedPhone,
          row.request.addressLine, row.request.city, row.request.notes, row.request.garmentPreferences, user.businessId, row.existingId, locked[0].Version]);
        if (!rowCount) throw AppError.conflict('import_changed', 'A customer changed after preview. Preview the file again before importing.');
        await client.query(`INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "EntityId", "EntityType")
          VALUES ($1, 'customer.updated', $2, $3, now(), $4, 'Customer')`, [randomUUID(), user.userId, user.businessId, row.existingId]);
        updated += 1;
      }
    }
    await client.query(`INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityType")
      VALUES ($1, 'customer.csv_imported', $2, $3, now(), $4::jsonb, 'Customer')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ created, updated, skipped, failed: 0, rows: fresh.length })]);
    return { created, updated, skipped, failed: 0, stoppedEarly: false, problems };
  });
}

async function withAtomicImport(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}