import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';

/** The most rows one export may contain. A bigger result is refused so the person narrows the filters. */
export const EXPORT_ROW_LIMIT = 50_000;
/** Rows read from the list query per round trip. */
export const EXPORT_PAGE_SIZE = 500;

/**
 * A text cell. A value that a spreadsheet could read as a formula gets a leading apostrophe,
 * and a value with a comma, quote or line break is quoted.
 */
export function textCell(value) {
  let text = value === null || value === undefined ? '' : String(value).replaceAll('\0', '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * A number cell. Numbers are written as they are, so a negative amount keeps its minus sign
 * (the text guard above would corrupt it). Anything that is not a finite number is left empty.
 */
export function numberCell(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '';
}

/** A calendar day as YYYY-MM-DD, from a Date (as the driver returns a date column) or a date string. */
export function dayText(value) {
  if (value === null || value === undefined || value === '') return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** A yes or no cell. */
export function yesNoCell(value) {
  return value ? 'yes' : 'no';
}

/**
 * Build a CSV file from a paged source.
 *
 * columns: [{ header, get: (row) => value, kind: 'text' | 'number' | 'yesno' }]
 * fetchPage: async (page, pageSize) => ({ items, totalCount })
 *
 * The first page tells how many rows match; a result over the limit is refused with 413
 * before any more pages are read. Returns { csv, rowCount }.
 */
export async function buildCsv({ columns, fetchPage, rowLimit = EXPORT_ROW_LIMIT, pageSize = EXPORT_PAGE_SIZE, noun = 'rows' }) {
  const lines = [columns.map((column) => textCell(column.header)).join(',')];
  const seen = new Set();
  let rowCount = 0;
  let page = 1;
  for (;;) {
    const result = await fetchPage(page, pageSize);
    if (result.totalCount > rowLimit) {
      throw new AppError(413, 'export_too_large',
        `Exports are limited to ${rowLimit} ${noun}. Narrow the filters and try again.`);
    }
    for (const row of result.items) {
      // The list queries sort on a unique key, so a repeated row means the data moved while the file was being read.
      if (row.id !== undefined) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
      }
      lines.push(columns.map((column) => {
        const value = column.get(row);
        if (column.kind === 'number') return numberCell(value);
        if (column.kind === 'yesno') return yesNoCell(value);
        return textCell(value);
      }).join(','));
      rowCount += 1;
    }
    if (!result.items.length || result.items.length < pageSize || page * pageSize >= result.totalCount) break;
    page += 1;
  }
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, rowCount };
}

/** Today's date as YYYYMMDD, for the file name. */
export function fileDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Send a finished CSV as a download. */
export function sendCsv(res, base, csv) {
  return res.status(200).type('text/csv; charset=utf-8').attachment(`${base}-${fileDate()}.csv`).send(csv);
}

/**
 * Record that a person exported data. The entry holds the kind, the row count and the filter names
 * that were used, never any of the exported content. If this write fails the export fails too.
 */
export async function recordExportAudit(db, user, kind, rowCount, filters = {}) {
  const used = Object.fromEntries(Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, key === 'search' ? true : value]));
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
      "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, NULL, 'Export')`,
  [randomUUID(), `export.${kind}`, user.userId, user.businessId, JSON.stringify({ rowCount, filters: used })]);
}
