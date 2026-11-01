// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiList } from '../client';
import { ApiError } from '../problem';

afterEach(() => { vi.unstubAllGlobals(); });

const respond = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));

describe('apiList', () => {
  it('returns the rows with the total and truncation from the headers', async () => {
    const fetchMock = respond([{ id: 1 }, { id: 2 }], { 'x-total-count': '1350', 'x-truncated': 'true' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await apiList('/api/inventory')).toEqual({ items: [{ id: 1 }, { id: 2 }], totalCount: 1350, truncated: true });
    expect(fetchMock).toHaveBeenCalledWith('/backend/api/inventory', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
  });

  it('falls back to the row count when the headers are missing', async () => {
    vi.stubGlobal('fetch', respond([{ id: 1 }]));
    expect(await apiList('/api/suppliers')).toEqual({ items: [{ id: 1 }], totalCount: 1, truncated: false });
  });

  it('throws an ApiError for a refusal and for a network failure', async () => {
    vi.stubGlobal('fetch', respond({}, {}, 403));
    await expect(apiList('/api/inventory')).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(apiList('/api/inventory')).rejects.toMatchObject({ status: 0 });
  });
});
