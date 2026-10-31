import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import yauzl from 'yauzl';
import { AppError } from '../http/errors.js';
import { isBlank, matchEnum } from '../http/enums.js';
import { checkStorageQuota } from './mediaService.js';

const DOCUMENT_KINDS = ['Pdf', 'Word', 'Excel', 'Text'];
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

async function inTransaction(pool, work) {
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

function inspectArchive(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (openError, archive) => {
      if (openError || !archive) { reject(AppError.badRequest('unsupported_document', 'This file is damaged or not a supported document.')); return; }
      let entries = 0;
      let declaredBytes = 0;
      const names = new Set();
      let contentTypes = null;
      archive.on('error', () => reject(AppError.badRequest('unsupported_document', 'This file is damaged or not a supported document.')));
      archive.on('entry', (entry) => {
        entries += 1;
        declaredBytes += entry.uncompressedSize;
        if (entries > 5000 || declaredBytes > 200 * 1024 * 1024) {
          archive.close();
          reject(AppError.badRequest('unsafe_archive', 'This file is too large or complex to accept.'));
          return;
        }
        const name = entry.fileName.toLowerCase();
        names.add(name);
        if (name.endsWith('vbaproject.bin')) {
          archive.close();
          reject(AppError.badRequest('macros_not_allowed', 'Files with macros are not accepted.'));
          return;
        }
        if (name === '[content_types].xml') {
          if (entry.uncompressedSize > 1024 * 1024) {
            archive.close();
            reject(AppError.badRequest('unsafe_archive', 'This file is too large or complex to accept.'));
            return;
          }
          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) { reject(AppError.badRequest('unsupported_document', 'This file is damaged or not a supported document.')); return; }
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('error', () => reject(AppError.badRequest('unsupported_document', 'This file is damaged or not a supported document.')));
            stream.on('end', () => {
              contentTypes = Buffer.concat(chunks).toString('utf8');
              if (/macroEnabled/i.test(contentTypes)) reject(AppError.badRequest('macros_not_allowed', 'Files with macros are not accepted.'));
              else archive.readEntry();
            });
          });
        } else archive.readEntry();
      });
      archive.on('end', () => {
        if (!contentTypes) { reject(AppError.badRequest('unsupported_document', 'Only PDF, .docx, .xlsx, .txt and .csv files are accepted.')); return; }
        if (names.has('word/document.xml')) resolve({ kind: 'Word', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        else if (names.has('xl/workbook.xml')) resolve({ kind: 'Excel', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        else reject(AppError.badRequest('unsupported_document', 'Only PDF, .docx, .xlsx, .txt and .csv files are accepted.'));
      });
      archive.readEntry();
    });
  });
}

export async function sniffDocument(bytes, fileName) {
  const extension = path.extname(String(fileName ?? '').replaceAll('\\', '/').split('/').at(-1) ?? '').toLowerCase();
  let sniffed;
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') sniffed = { kind: 'Pdf', contentType: 'application/pdf' };
  else if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) sniffed = await inspectArchive(bytes);
  else if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw AppError.badRequest('unsupported_document', 'Old Word/Excel formats (.doc, .xls) are not accepted. Save as .docx or .xlsx.');
  } else if (extension === '.txt' || extension === '.csv') {
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) throw AppError.badRequest('invalid_text', 'This is not a plain text file.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw AppError.badRequest('invalid_text', 'Text files must be UTF-8.'); }
    sniffed = { kind: 'Text', contentType: extension === '.csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8' };
  } else throw AppError.badRequest('unsupported_document', 'Only PDF, .docx, .xlsx, .txt and .csv files are accepted.');

  const allowed = { Pdf: ['.pdf'], Word: ['.docx'], Excel: ['.xlsx'], Text: ['.txt', '.csv'] }[sniffed.kind];
  if (!allowed.includes(extension)) throw AppError.badRequest('extension_mismatch', `The file name must end with ${allowed.join(' or ')} to match what the file contains.`);
  return sniffed;
}

export function createVirusScanner(env) {
  if (env.ANTIVIRUS_PROVIDER !== 'clamav') return { async scan() { return { outcome: 'Disabled' }; } };
  return {
    async scan(bytes) {
      return new Promise((resolve) => {
        const socket = createConnection({ host: env.ANTIVIRUS_HOST, port: env.ANTIVIRUS_PORT });
        let settled = false;
        const timeout = setTimeout(() => finish({ outcome: 'Unavailable' }), (env.ANTIVIRUS_TIMEOUT_SECONDS ?? 30) * 1000);
        const chunks = [];
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          socket.destroy();
          resolve(result);
        };
        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
            const length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length);
            socket.write(length);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4));
        });
        socket.on('data', (chunk) => {
          chunks.push(chunk);
          if (chunk.includes(0)) {
            const response = Buffer.concat(chunks).toString('utf8');
            finish(response.includes('FOUND') ? { outcome: 'Infected', detail: response.trim() }
              : response.includes('OK') ? { outcome: 'Clean' } : { outcome: 'Unavailable' });
          }
        });
        socket.on('error', () => finish({ outcome: 'Unavailable' }));
        socket.on('end', () => {
          const response = Buffer.concat(chunks).toString('utf8');
          finish(response.includes('FOUND') ? { outcome: 'Infected', detail: response.trim() }
            : response.includes('OK') ? { outcome: 'Clean' } : { outcome: 'Unavailable' });
        });
      });
    },
  };
}

function safeFileName(value) {
  const base = String(value ?? '').replaceAll('\\', '/').split('/').at(-1) ?? '';
  return [...base].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim().slice(0, 200) || 'document';
}

function documentDto(row) {
  return { id: row.Id, fileName: row.FileName, kind: row.Kind, contentType: row.ContentType,
    sizeBytes: Number(row.SizeBytes), description: row.Description, customerId: row.CustomerId, orderId: row.OrderId,
    scanStatus: row.ScanStatus, createdAtUtc: row.CreatedAtUtc };
}

export async function uploadDocument(pool, env, storage, scanner, user, bytes, fileName, fields) {
  if (!bytes?.length) throw AppError.badRequest('empty_file', 'The uploaded file is empty.');
  if (bytes.length > env.DOCUMENT_MAX_UPLOAD_BYTES) throw new AppError(413, 'file_too_large', `Documents can be at most ${Math.floor(env.DOCUMENT_MAX_UPLOAD_BYTES / 1_048_576)} MB.`);
  const sniffed = await sniffDocument(bytes, fileName);
  let customerId = clean(fields.customerId);
  const orderId = clean(fields.orderId);
  if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
  if (orderId && !/^[0-9a-f-]{36}$/i.test(orderId)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
  if (orderId) {
    const { rows } = await pool.query(`SELECT "CustomerId", "LocationId" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2`, [user.businessId, orderId]);
    if (!rows[0]) throw AppError.notFound('order_not_found', 'Order not found.');
    if (!user.isOwner && !user.permissions.includes('locations.all')) {
      const { rows: grants } = await pool.query(`SELECT DISTINCT ml."LocationId" FROM "Memberships" m
        JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
        WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`, [user.userId, user.businessId]);
      if (!grants.some((grant) => grant.LocationId === rows[0].LocationId)) throw AppError.notFound('order_not_found', 'Order not found.');
    }
    if (customerId && customerId !== rows[0].CustomerId) throw AppError.badRequest('customer_order_mismatch', 'That order belongs to a different customer.');
    customerId ??= rows[0].CustomerId;
  } else if (customerId) {
    const { rows } = await pool.query(`SELECT 1 FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2`, [user.businessId, customerId]);
    if (!rows.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
  }

  const scan = await scanner.scan(bytes);
  let scanStatus = 'NotScanned';
  if (scan.outcome === 'Clean') scanStatus = 'Clean';
  else if (scan.outcome === 'Infected') {
    await pool.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityType")
      VALUES ($1, 'document.rejected_infected', $2, $3, now(), $4::jsonb, 'StoredDocument')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ signature: scan.detail })]);
    throw new AppError(422, 'file_infected', 'This file was rejected because it contains malware.');
  } else if (scan.outcome === 'Unavailable' && env.ANTIVIRUS_REQUIRED) {
    throw new AppError(503, 'scan_unavailable', 'The virus scanner is unavailable, so the file was not accepted. Try again shortly.');
  }

  const id = randomUUID();
  const key = `${user.businessId.replaceAll('-', '')}/d/${id.replaceAll('-', '')}.bin`;
  let written = false;
  try {
    return await inTransaction(pool, async (client) => {
      await checkStorageQuota(client, env, user.businessId, bytes.length);
      await storage.put(key, bytes, sniffed.contentType);
      written = true;
      const description = clean(fields.description)?.slice(0, 500) ?? null;
      const { rows } = await client.query(`
        INSERT INTO "Documents" ("Id", "BusinessId", "ContentType", "CreatedAtUtc", "CustomerId", "Description", "FileName", "Kind", "OrderId", "ScanStatus", "Sha256", "SizeBytes", "UploadedByUserId")
        VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING "Id", "FileName", "Kind", "ContentType", "SizeBytes", "Description", "CustomerId", "OrderId", "ScanStatus", "CreatedAtUtc"`,
      [id, user.businessId, sniffed.contentType, customerId, description, safeFileName(fileName), sniffed.kind, orderId,
        scanStatus, createHash('sha256').update(bytes).digest('hex'), bytes.length, user.userId]);
      await client.query(`
        INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
        VALUES ($1, 'document.uploaded', $2, $3, now(), $4::jsonb, $5, 'StoredDocument')`,
      [randomUUID(), user.userId, user.businessId, JSON.stringify({ sizeBytes: bytes.length, kind: sniffed.kind }), id]);
      return documentDto(rows[0]);
    });
  } catch (error) {
    if (written) await storage.delete(key).catch(() => {});
    throw error;
  }
}

function parseDocumentQuery(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  const kind = isBlank(query.kind) ? null : matchEnum(String(query.kind), DOCUMENT_KINDS);
  for (const [name, value] of [['customerId', query.customerId], ['orderId', query.orderId]]) {
    if (value !== undefined && !/^[0-9a-f-]{36}$/i.test(String(value))) throw AppError.badRequest(`invalid_${name}`, `The ${name} is invalid.`);
  }
  if (!isBlank(query.kind) && kind === undefined) throw AppError.badRequest('invalid_kind', `'${query.kind}' is not a valid kind.`);
  return { page, pageSize, kind, customerId: query.customerId ? String(query.customerId) : null, orderId: query.orderId ? String(query.orderId) : null };
}

export async function listDocuments(pool, user, query) {
  const filter = parseDocumentQuery(query);
  const params = [user.businessId];
  const clauses = ['"BusinessId" = $1'];
  for (const [column, value] of [['CustomerId', filter.customerId], ['OrderId', filter.orderId], ['Kind', filter.kind]]) {
    if (value) { params.push(value); clauses.push(`"${column}" = $${params.length}`); }
  }
  const where = clauses.join(' AND ');
  const { rows: counts } = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "Documents" WHERE ${where}`, params);
  const { rows } = await pool.query(`SELECT "Id", "FileName", "Kind", "ContentType", "SizeBytes", "Description", "CustomerId", "OrderId", "ScanStatus", "CreatedAtUtc"
    FROM "Documents" WHERE ${where} ORDER BY "CreatedAtUtc" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, filter.pageSize, (filter.page - 1) * filter.pageSize]);
  return { items: rows.map(documentDto), page: filter.page, pageSize: filter.pageSize, totalCount: counts[0]?.TotalCount ?? 0 };
}

export async function getDocument(pool, user, id) {
  const { rows } = await pool.query(`SELECT "Id", "FileName", "Kind", "ContentType", "SizeBytes", "Description", "CustomerId", "OrderId", "ScanStatus", "CreatedAtUtc"
    FROM "Documents" WHERE "BusinessId" = $1 AND "Id" = $2`, [user.businessId, id]);
  if (!rows[0]) throw AppError.notFound('document_not_found', 'Document not found.');
  return documentDto(rows[0]);
}

export async function openDocument(pool, storage, user, id) {
  const { rows } = await pool.query(`SELECT "Id", "BusinessId", "FileName", "ContentType", "SizeBytes" FROM "Documents" WHERE "BusinessId" = $1 AND "Id" = $2`, [user.businessId, id]);
  const document = rows[0];
  if (!document) throw AppError.notFound('document_not_found', 'Document not found.');
  const key = `${document.BusinessId.replaceAll('-', '')}/d/${document.Id.replaceAll('-', '')}.bin`;
  const content = await storage.openRead(key);
  if (!content) throw AppError.notFound('document_missing', 'The file for this document is missing.');
  return { content, contentType: document.ContentType, fileName: document.FileName, length: Number(document.SizeBytes) };
}

export async function deleteDocument(pool, storage, user, id) {
  const document = await inTransaction(pool, async (client) => {
    const { rows } = await client.query(`DELETE FROM "Documents" WHERE "BusinessId" = $1 AND "Id" = $2 RETURNING "BusinessId", "Id", "SizeBytes"`, [user.businessId, id]);
    if (!rows[0]) throw AppError.notFound('document_not_found', 'Document not found.');
    await client.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'document.deleted', $2, $3, now(), $4::jsonb, $5, 'StoredDocument')`,
    [randomUUID(), user.userId, user.businessId, JSON.stringify({ sizeBytes: Number(rows[0].SizeBytes) }), id]);
    return rows[0];
  });
  await storage.delete(`${document.BusinessId.replaceAll('-', '')}/d/${document.Id.replaceAll('-', '')}.bin`).catch(() => {});
}