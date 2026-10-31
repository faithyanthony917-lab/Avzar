'use client';

import { useState } from 'react';

export const CLIENT_PAGE_SIZE = 10;

/** Splits an already-loaded list into pages. The current page is clamped, so deleting the last row of the last page never leaves an empty page. */
export function usePaged<T>(items: readonly T[], size: number = CLIENT_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages);
  const slice = items.slice((current - 1) * size, current * size);
  return { slice, page: current, pages, total: items.length, size, setPage };
}

type PagerProps = { page: number; pages: number; total: number; size: number; onPage: (page: number) => void; label?: string };

/** Previous / Next controls with a "Showing 1–10 of 42" line. Renders nothing when everything fits on one page. */
export function Pager({ page, pages, total, size, onPage, label = 'Pagination' }: PagerProps) {
  if (total <= size) return null;
  const from = (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  return (
    <nav className="ap-pager" aria-label={label}>
      <span className="ap-foot">Showing {from}–{to} of {total}</span>
      <div className="ap-actions">
        <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span className="ap-foot" aria-current="page">Page {page} of {pages}</span>
        <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}
