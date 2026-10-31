// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { PurchaseOrderDetail, type PurchaseOrder } from '@/components/app/PurchaseOrderDetail';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const po = (over: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  Id: 'p1', OrderNumber: 'PO-001', Status: 'Ordered', SupplierName: 'Lagos Fabrics', LocationName: 'Calabar south', Subtotal: '15000.00', Currency: 'NGN',
  ExpectedAtUtc: null, OrderedAtUtc: '2026-10-21T09:00:00Z', ReceivedAtUtc: null, Notes: null,
  items: [
    { Id: 'i1', Description: 'Silk', Sku: 'SILK-1', QuantityOrdered: '10.000', QuantityReceived: '0.000', UnitCost: '1500.00', StockItemId: 'm1' },
    { Id: 'i2', Description: 'Old buttons', Sku: null, QuantityOrdered: '5.000', QuantityReceived: '0.000', UnitCost: '100.00', StockItemId: null },
  ], ...over,
});
const receiveCalls = () => apiMock.mock.calls.filter(([path]) => String(path).endsWith('/receive'));

beforeEach(() => { apiMock.mockReset(); });

describe('PurchaseOrderDetail', () => {
  it('shows loading, then the order with ordered, received and left counts', async () => {
    apiMock.mockResolvedValue(po());
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    expect(screen.getByText('Loading purchase order…')).toBeInTheDocument();
    expect(await screen.findByText('PO-001')).toBeInTheDocument();
    expect(screen.getByText(/Ordered 10 · received 0 · left 10/)).toBeInTheDocument();
    expect(screen.getByText('Ordered', { selector: '.ap-badge' })).toBeInTheDocument();
  });

  it('lets a draft be marked as ordered or cancelled, but not received', async () => {
    apiMock.mockResolvedValue(po({ Status: 'Draft', OrderedAtUtc: null }));
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    expect(await screen.findByRole('button', { name: 'Mark as ordered' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record received stock' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    expect(await screen.findByText('Marked as ordered.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/purchase-orders/p1/order', { method: 'POST' });
  });

  it('asks before cancelling, and can be backed out of', async () => {
    apiMock.mockResolvedValue(po());
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Cancel purchase order PO-001?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(apiMock.mock.calls.some(([path]) => String(path).endsWith('/cancel'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    expect(await screen.findByText('Purchase order cancelled.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/purchase-orders/p1/cancel', { method: 'POST' });
  });

  it('hides cancel once stock has been received', async () => {
    apiMock.mockResolvedValue(po({ Status: 'PartiallyReceived', items: [{ ...po().items[0]!, QuantityReceived: '4.000' }] }));
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    await screen.findByText('PO-001');
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record received stock' })).toBeInTheDocument();
  });

  it('explains an item with no stock item instead of offering a quantity box', async () => {
    apiMock.mockResolvedValue(po());
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    await screen.findByText('PO-001');
    expect(screen.getByLabelText('Receive Silk')).toBeInTheDocument();
    expect(screen.queryByLabelText('Receive Old buttons')).not.toBeInTheDocument();
    expect(screen.getByText(/not linked to a stock item/)).toBeInTheDocument();
  });

  it('refuses a receipt that is empty or above what is left, without calling the API', async () => {
    apiMock.mockResolvedValue(po());
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    await screen.findByText('PO-001');
    fireEvent.click(screen.getByRole('button', { name: 'Record received stock' }));
    expect(await screen.findByText(/at least one item/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Receive Silk'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record received stock' }));
    expect(await screen.findByText(/only 10 left to receive/)).toBeInTheDocument();
    expect(receiveCalls()).toHaveLength(0);
  });

  it('records a receipt with an idempotency key and reloads', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => (init?.method === 'POST' ? { duplicate: false } : po()));
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    await screen.findByText('PO-001');
    fireEvent.change(screen.getByLabelText('Receive Silk'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record received stock' }));
    expect(await screen.findByText('Stock received.')).toBeInTheDocument();
    const [path, init] = receiveCalls()[0]!;
    expect(path).toBe('/api/purchase-orders/p1/receive');
    expect(init.json.items).toEqual([{ itemId: 'i1', quantity: 4 }]);
    expect(String(init.json.idempotencyKey).length).toBeGreaterThanOrEqual(8);
  });

  it('reuses the same key when the same receipt is retried, and a new key once the quantity changes', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw new ApiError(500, 'Server error.');
      return po();
    });
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    await screen.findByText('PO-001');
    fireEvent.change(screen.getByLabelText('Receive Silk'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record received stock' }));
    await waitFor(() => expect(receiveCalls()).toHaveLength(1));
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record received stock' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Record received stock' }));
    await waitFor(() => expect(receiveCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record received stock' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Receive Silk'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record received stock' }));
    await waitFor(() => expect(receiveCalls()).toHaveLength(3));
    const keys = receiveCalls().map(([, init]) => init.json.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('says so when the server reports the receipt was already recorded', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => (init?.method === 'POST' ? { duplicate: true } : po()));
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    await screen.findByText('PO-001');
    fireEvent.change(screen.getByLabelText('Receive Silk'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record received stock' }));
    expect(await screen.findByText(/already recorded/)).toBeInTheDocument();
  });

  it('shows the order read-only without inventory.manage', async () => {
    apiMock.mockResolvedValue(po());
    render(<><PurchaseOrderDetail id="p1" canManage={false} /><Toaster /></>);
    await screen.findByText('PO-001');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Receive Silk')).not.toBeInTheDocument();
  });

  it('shows a load error with a working retry', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(404, 'Purchase order not found.')).mockResolvedValueOnce(po());
    render(<><PurchaseOrderDetail id="p1" canManage /><Toaster /></>);
    expect(await screen.findByText('Purchase order not found.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading this purchase order' }));
    expect(await screen.findByText('PO-001')).toBeInTheDocument();
  });
});
