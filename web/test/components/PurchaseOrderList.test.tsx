// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ apiList: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { apiList } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { PurchaseOrderList, type PurchaseOrderRow } from '@/components/app/PurchaseOrderList';

const listMock = vi.mocked(apiList) as unknown as ReturnType<typeof vi.fn>;
const listOf = (items: PurchaseOrderRow[], totalCount = items.length) => ({ items, totalCount, truncated: totalCount > items.length });
const row = (over: Partial<PurchaseOrderRow> = {}): PurchaseOrderRow => ({ Id: 'p1', OrderNumber: 'PO-001', Status: 'Ordered', SupplierName: 'Lagos Fabrics', LocationName: 'Calabar south', Subtotal: '15000.00', Currency: 'NGN', ExpectedAtUtc: null, CreatedAtUtc: '2026-10-20T09:00:00Z', ...over });

beforeEach(() => { listMock.mockReset(); });

describe('PurchaseOrderList', () => {
  it('shows loading, then the empty state, with the new-order link for managers only', async () => {
    listMock.mockResolvedValue(listOf([]));
    const { unmount } = render(<PurchaseOrderList canManage />);
    expect(screen.getByText('Loading purchase orders…')).toBeInTheDocument();
    expect(await screen.findByText('No purchase orders yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New purchase order' })).toHaveAttribute('href', '/inventory/purchase-orders/new');
    unmount();
    render(<PurchaseOrderList canManage={false} />);
    await screen.findByText('No purchase orders yet.');
    expect(screen.queryByRole('link', { name: 'New purchase order' })).not.toBeInTheDocument();
  });

  it('lists orders as links to their detail page and filters by status', async () => {
    listMock.mockResolvedValue(listOf([row(), row({ Id: 'p2', OrderNumber: 'PO-002', Status: 'Draft' })]));
    render(<PurchaseOrderList canManage />);
    expect(await screen.findByRole('link', { name: /PO-001/ })).toHaveAttribute('href', '/inventory/purchase-orders/p1');
    expect(screen.getByRole('link', { name: /PO-002/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Draft' } });
    expect(screen.queryByRole('link', { name: /PO-001/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /PO-002/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Received' } });
    expect(screen.getByText('No purchase orders with that status.')).toBeInTheDocument();
  });

  it('shows a load error with a working retry', async () => {
    listMock.mockRejectedValueOnce(new ApiError(500, 'Server error.')).mockResolvedValueOnce(listOf([row()]));
    render(<PurchaseOrderList canManage />);
    expect(await screen.findByText('Server error.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading purchase orders' }));
    expect(await screen.findByRole('link', { name: /PO-001/ })).toBeInTheDocument();
  });

  it('says so when the list was cut at the limit', async () => {
    listMock.mockResolvedValue(listOf([row()], 1350));
    render(<PurchaseOrderList canManage={false} />);
    expect(await screen.findByText(/Showing the first 1 of 1,350/)).toBeInTheDocument();
  });

  it('shows no notice when every purchase order is listed', async () => {
    listMock.mockResolvedValue(listOf([row()]));
    render(<PurchaseOrderList canManage={false} />);
    await screen.findByText('PO-001');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });
});
