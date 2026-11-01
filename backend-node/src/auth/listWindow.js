import { AppError } from '../http/errors.js';

/*
 * Lists that return a plain array (screens and pickers read the whole list) keep doing so, but never without a limit.
 *
 *  - No paging parameters: the first LIST_CAP rows as a plain array, with X-Total-Count, X-Result-Limit and X-Truncated headers,
 *    so a screen can say "showing 1000 of 1350" instead of silently losing rows.
 *  - `page` and/or `pageSize` (1 to 100): the standard { items, page, pageSize, totalCount } envelope.
 */
export const LIST_CAP = 1000;
export const LIST_PAGE_MAX = 100;

/** Reads optional paging parameters; null when neither is given. */
export function optionalPaging(query) {
  if (query.page === undefined && query.pageSize === undefined) return null;
  const page = Number.parseInt(query.page ?? '1', 10);
  const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > LIST_PAGE_MAX) {
    throw AppError.badRequest('invalid_paging', `Page must be positive and pageSize must be between 1 and ${LIST_PAGE_MAX}.`);
  }
  return { page, pageSize };
}

/**
 * Runs a complete SELECT (ending in an ORDER BY on a unique key, with no LIMIT) for one window, and counts all matching rows.
 * query: async (sql, params) => ({ rows }).
 */
export async function windowedRows(query, sql, params, { limit, offset }) {
  const next = params.length;
  const data = await query(`${sql} LIMIT $${next + 1} OFFSET $${next + 2}`, [...params, limit, offset]);
  const count = await query(`SELECT count(*)::int AS "TotalCount" FROM (${sql}) counted`, params);
  return { rows: data.rows, totalCount: Number(count.rows[0]?.TotalCount ?? 0) };
}

/** Sends a list as an envelope (paged) or as a capped plain array with total headers. fetch({ limit, offset }) => { rows, totalCount }. */
export async function respondList(res, query, fetch, { cap = LIST_CAP } = {}) {
  const paging = optionalPaging(query);
  if (paging) {
    const { rows, totalCount } = await fetch({ limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
    return res.status(200).json({ items: rows, page: paging.page, pageSize: paging.pageSize, totalCount });
  }
  const { rows, totalCount } = await fetch({ limit: cap, offset: 0 });
  res.set({ 'X-Total-Count': String(totalCount), 'X-Result-Limit': String(cap), 'X-Truncated': totalCount > cap ? 'true' : 'false' });
  return res.status(200).json(rows);
}
