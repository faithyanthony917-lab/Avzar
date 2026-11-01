// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadExport, exportFileName, exportQuery } from '../csv-export';
import { ApiError } from '../problem';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('exportQuery', () => {
  it('drops paging and keeps the filters', () => {
    expect(exportQuery('page=3&pageSize=25&status=Quoted&search=Ada+Obi')).toBe('status=Quoted&search=Ada+Obi');
    expect(exportQuery('')).toBe('');
  });
});

describe('exportFileName', () => {
  it('uses the server name when it is plain, else the fallback', () => {
    expect(exportFileName('attachment; filename="orders-20261101.csv"', 'x.csv')).toBe('orders-20261101.csv');
    expect(exportFileName(null, 'x.csv')).toBe('x.csv');
    expect(exportFileName('attachment; filename="../evil.csv"', 'x.csv')).toBe('x.csv');
  });
});

describe('downloadExport', () => {
  const stubDownload = () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    return click;
  };

  it('requests the export without paging and starts a download', async () => {
    const click = stubDownload();
    const fetchMock = vi.fn(async () => new Response('a,b\r\n', { status: 200, headers: { 'content-disposition': 'attachment; filename="invoices-20261101.csv"' } }));
    vi.stubGlobal('fetch', fetchMock);
    await downloadExport('/api/invoices/export', 'page=2&pageSize=25&overdue=true', 'fallback.csv');
    expect(fetchMock).toHaveBeenCalledWith('/backend/api/invoices/export?overdue=true', expect.objectContaining({ credentials: 'same-origin' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('turns a too-many-rows refusal into a plain message and downloads nothing', async () => {
    const click = stubDownload();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'export_too_large', title: 'Exports are limited to 50000 orders.' }), { status: 413 })));
    await expect(downloadExport('/api/orders/export')).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/too many rows/i) });
    expect(click).not.toHaveBeenCalled();
  });

  it('shows a permission refusal as an ApiError', async () => {
    stubDownload();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    await expect(downloadExport('/api/payments/export')).rejects.toBeInstanceOf(ApiError);
  });

  it('reports a network failure without throwing a raw error', async () => {
    stubDownload();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await expect(downloadExport('/api/orders/export')).rejects.toMatchObject({ status: 0 });
  });
});
