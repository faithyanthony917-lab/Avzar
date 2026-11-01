// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/csv-export', () => ({ downloadExport: vi.fn() }));

import { downloadExport } from '@/lib/csv-export';
import { ApiError } from '@/lib/problem';
import { ExportCsvButton } from '@/components/app/ExportCsvButton';

const downloadMock = vi.mocked(downloadExport) as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => downloadMock.mockReset());

describe('ExportCsvButton', () => {
  it('asks for the export with the screen filters and the file name', async () => {
    downloadMock.mockResolvedValue(undefined);
    render(<ExportCsvButton path="/api/orders/export" query="status=Quoted&page=2" fileName="orders.csv" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledWith('/api/orders/export', 'status=Quoted&page=2', 'orders.csv'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is disabled while the file is prepared', async () => {
    let finish: () => void = () => {};
    downloadMock.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<ExportCsvButton path="/api/payments/export" fileName="payments.csv" label="Export all payments" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export all payments' }));
    expect(await screen.findByRole('button', { name: /preparing/i })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export all payments' })).toBeEnabled());
  });

  it('shows the refusal message next to the button', async () => {
    downloadMock.mockRejectedValue(new ApiError(413, 'There are too many rows to export at once. Narrow the filters and try again.', 'export_too_large'));
    render(<ExportCsvButton path="/api/invoices/export" fileName="invoices.csv" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/too many rows/i);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('shows a generic message for an unexpected error', async () => {
    downloadMock.mockRejectedValue(new Error('boom'));
    render(<ExportCsvButton path="/api/orders/export" fileName="orders.csv" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
  });
});
