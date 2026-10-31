export const STATUS_FILTERS = ['', 'Active', 'Inactive', 'Merged'] as const;
export const SORTS = ['name', 'name-desc', 'created', 'created-desc'] as const;
export const PAGE_SIZE = 25;

export interface ListQuery { search: string; status: string; sort: (typeof SORTS)[number]; page: number }

type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the URL's query string defensively: anything unrecognised falls back to the default. */
export function parseListQuery(raw: Raw): ListQuery {
  const search = (first(raw.search) ?? '').trim().slice(0, 100);
  const statusRaw = first(raw.status) ?? '';
  const status = (STATUS_FILTERS as readonly string[]).includes(statusRaw) ? statusRaw : '';
  const sortRaw = first(raw.sort) ?? 'name';
  const sort = (SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as ListQuery['sort']) : 'name';
  const pageNum = Number.parseInt(first(raw.page) ?? '1', 10);
  const page = Number.isFinite(pageNum) && pageNum >= 1 && pageNum <= 100000 ? pageNum : 1;
  return { search, status, sort, page };
}

/** The API's own query string for a list request. */
export function apiQueryString(q: ListQuery): string {
  const p = new URLSearchParams();
  p.set('page', String(q.page));
  p.set('pageSize', String(PAGE_SIZE));
  if (q.search) p.set('search', q.search);
  if (q.status) p.set('status', q.status);
  p.set('sort', q.sort.startsWith('created') ? 'created' : 'name');
  if (q.sort.endsWith('-desc')) p.set('descending', 'true');
  return p.toString();
}

/** A shareable page URL for the same filters (defaults are left out). */
export function listHref(q: ListQuery, overrides: Partial<ListQuery> = {}): string {
  const m = { ...q, ...overrides };
  const p = new URLSearchParams();
  if (m.search) p.set('search', m.search);
  if (m.status) p.set('status', m.status);
  if (m.sort !== 'name') p.set('sort', m.sort);
  if (m.page > 1) p.set('page', String(m.page));
  const s = p.toString();
  return s ? `/customers?${s}` : '/customers';
}

export const totalPages = (totalCount: number, pageSize = PAGE_SIZE) => Math.max(1, Math.ceil(totalCount / pageSize));

/** Blank form fields become undefined so the API's email and length rules are not tripped by empty strings. */
export const blankToUndefined = (s: string): string | undefined => (s.trim() === '' ? undefined : s.trim());

export const CHANNELS = [
  { value: 'Phone', label: 'Phone' }, { value: 'Email', label: 'Email' }, { value: 'WhatsApp', label: 'WhatsApp' },
  { value: 'InPerson', label: 'In person' }, { value: 'Other', label: 'Other' },
];
export const DIRECTIONS = [{ value: 'Outbound', label: 'We contacted them' }, { value: 'Inbound', label: 'They contacted us' }];
export const channelLabel = (v: string) => CHANNELS.find((c) => c.value === v)?.label ?? v;
export const directionLabel = (v: string) => DIRECTIONS.find((d) => d.value === v)?.label ?? v;
