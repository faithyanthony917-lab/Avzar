// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { PurchaseOrderForm } from '@/components/app/PurchaseOrderForm';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const suppliers = [{ Id: 's1', Name: 'Lagos Fabrics', ContactName: null, Email: null, Phone: null, Address: null, Notes: null, IsActive: true }, { Id: 's2', Name: 'Old Threads', ContactName: null, Email: null, Phone: null, Address: null, Notes: null, IsActive: false }];
const places = [{ id: 'l1', name: 'Calabar south' }];
const stock = [{ id: 'm1', locationId: null, sku: 'SILK-1', name: 'Silk', unit: 'm', active: true }, { id: 'm2', locationId: 'other', sku: 'LACE-1', name: 'Lace', unit: 'm', active: true }];

function serve(extra: Record<string, unknown> = {}) {
  apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path in extra) return extra[path];
    if (path === '/api/suppliers') return suppliers;
    if (path === '/api/inventory/locations') return places;
    if (path === '/api/inventory') return stock;
    if (path === '/api/expense-categories') return [{ id: 'c1', name: 'Materials', isActive: true }];
    if (path === '/api/purchase-orders' && init?.method === 'POST') return { Id: 'po9' };
    throw new Error(`unexpected ${path}`);
  });
}
beforeEach(() => { apiMock.mockReset(); push.mockReset(); });

async function fillValid() {
  await screen.findByLabelText('Supplier');
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 's1' } });
  fireEvent.change(screen.getByLabelText('Order number'), { target: { value: 'PO-100' } });
  fireEvent.change(screen.getByLabelText('Stock item 1'), { target: { value: 'm1' } });
  fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '12.5' } });
  fireEvent.change(screen.getByLabelText('Unit cost 1'), { target: { value: '1200' } });
}

describe('PurchaseOrderForm', () => {
  it('offers only active suppliers, preselects a single location and hides locations\' foreign stock', async () => {
    serve();
    render(<><PurchaseOrderForm canLinkExpense={false} defaultCurrency="NGN" /><Toaster /></>);
    await screen.findByLabelText('Supplier');
    expect(screen.getByRole('option', { name: 'Lagos Fabrics' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Old Threads' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Deliver to')).toHaveValue('l1');
    expect(screen.getByRole('option', { name: 'Silk (SILK-1)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Lace (LACE-1)' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Expense category (optional)')).not.toBeInTheDocument();
  });

  it('asks for a supplier first when none is active', async () => {
    serve({ '/api/suppliers': [suppliers[1]] });
    render(<><PurchaseOrderForm canLinkExpense={false} defaultCurrency="NGN" /><Toaster /></>);
    expect(await screen.findByText('Add an active supplier before creating a purchase order.')).toBeInTheDocument();
  });

  it('shows the expense category only to people who may link one', async () => {
    serve();
    render(<><PurchaseOrderForm canLinkExpense defaultCurrency="NGN" /><Toaster /></>);
    expect(await screen.findByLabelText('Expense category (optional)')).toBeInTheDocument();
  });

  it('refuses an item without a stock item or with a bad quantity, without saving', async () => {
    serve();
    render(<><PurchaseOrderForm canLinkExpense={false} defaultCurrency="NGN" /><Toaster /></>);
    await screen.findByLabelText('Supplier');
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('Order number'), { target: { value: 'PO-100' } });
    fireEvent.change(screen.getByLabelText('Description 1'), { target: { value: 'Silk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText(/choose the stock item it adds to/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Stock item 1'), { target: { value: 'm1' } });
    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Unit cost 1'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText(/quantity above zero/)).toBeInTheDocument();
    expect(apiMock.mock.calls.some(([path, init]) => path === '/api/purchase-orders' && init?.method === 'POST')).toBe(false);
  });

  it('saves a draft with the right body, shows the total, and opens the new order', async () => {
    serve();
    render(<><PurchaseOrderForm canLinkExpense defaultCurrency="NGN" /><Toaster /></>);
    await fillValid();
    fireEvent.change(screen.getByLabelText('Expected on (optional)'), { target: { value: '2026-11-05' } });
    fireEvent.change(screen.getByLabelText('Expense category (optional)'), { target: { value: 'c1' } });
    expect(screen.getByText(/Total:/)).toHaveTextContent('15,000');
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/inventory/purchase-orders/po9'));
    expect(apiMock).toHaveBeenCalledWith('/api/purchase-orders', { method: 'POST', json: {
      supplierId: 's1', locationId: 'l1', orderNumber: 'PO-100', currency: 'NGN', expectedAtUtc: '2026-11-05T00:00:00.000Z', expenseCategoryId: 'c1',
      items: [{ description: 'Silk', sku: 'SILK-1', quantityOrdered: 12.5, unitCost: 1200, stockItemId: 'm1' }],
    } });
  });

  it('shows the server\'s refusal and stays editable', async () => {
    serve();
    render(<><PurchaseOrderForm canLinkExpense={false} defaultCurrency="NGN" /><Toaster /></>);
    await fillValid();
    apiMock.mockImplementationOnce(async () => { throw new ApiError(409, 'That order number is already used.', 'conflict'); });
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That order number is already used.');
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save as draft' })).toBeEnabled();
  });

  it('adds and removes item rows', async () => {
    serve();
    render(<><PurchaseOrderForm canLinkExpense={false} defaultCurrency="NGN" /><Toaster /></>);
    await screen.findByLabelText('Supplier');
    expect(screen.queryByRole('button', { name: /Remove item/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add another item' }));
    expect(screen.getByLabelText('Quantity 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove item 2' }));
    expect(screen.queryByLabelText('Quantity 2')).not.toBeInTheDocument();
  });
});
