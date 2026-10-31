import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'abc' }) }) }));

import { serverGet } from '@/lib/session';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('serverGet failures', () => {
  it('passes the API error code through', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 403, code: 'feature_not_in_plan', title: 'No' }), { status: 403 }));
    expect(await serverGet('/api/production/workload')).toEqual({ ok: false, status: 403, code: 'feature_not_in_plan' });
  });
  it('leaves the code out when the body is empty or not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    expect(await serverGet('/x')).toEqual({ ok: false, status: 500, code: undefined });
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    expect(await serverGet('/x')).toEqual({ ok: false, status: 502, code: undefined });
  });
  it('still returns data on success and 502 when the API is unreachable', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    expect(await serverGet('/x')).toEqual({ ok: true, data: { a: 1 } });
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await serverGet('/x')).toEqual({ ok: false, status: 502 });
  });
});
