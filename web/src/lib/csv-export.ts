import { ApiError, readProblem } from './problem';

const BASE = '/backend';

/** The filter string of a list screen without its paging: an export always reads every page. */
export function exportQuery(query: string): string {
  const params = new URLSearchParams(query);
  params.delete('page');
  params.delete('pageSize');
  return params.toString();
}

/** The file name the server suggested, or the fallback when the header is missing or odd. */
export function exportFileName(disposition: string | null, fallback: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  const name = match?.[1]?.trim();
  return name && /^[\w.-]+$/.test(name) ? name : fallback;
}

/**
 * Download a CSV export through the same-origin proxy. A refusal (no permission, too many rows, bad filter)
 * throws an ApiError with a message that is safe to show, instead of sending the person to a JSON page.
 */
export async function downloadExport(path: string, query = '', fallbackName = 'export.csv'): Promise<void> {
  const search = exportQuery(query);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${search ? `?${search}` : ''}`, {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'text/csv' },
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const problem = await readProblem(res);
    if (problem.code === 'export_too_large' && res.status === 413) {
      throw new ApiError(413, 'There are too many rows to export at once. Narrow the filters and try again.', problem.code);
    }
    throw problem;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFileName(res.headers.get('content-disposition'), fallbackName);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
