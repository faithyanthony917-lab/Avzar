// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { SupplierManager, type Supplier } from '@/components/app/SupplierManager';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const supplier = (over: Partial<Supplier> = {}): Supplier => ({ Id: 's1', Name: 'Lagos Fabrics', ContactName: 'Ada', Email: 'ada@example.com', Phone: '+2348011112222', Address: 'Balogun Market', Notes: 'Pays on delivery', IsActive: true, ...over });

beforeEach(() => { apiMock.mockReset(); });

describe('SupplierManager', () => {
  it('shows loading, then the empty state and the add form', async () => {
    apiMock.mockResolvedValue([]);
    render(<><SupplierManager canManage /><Toaster /></>);
    expect(screen.getByText('Loading suppliers…')).toBeInTheDocument();
    expect(await screen.findByText('No suppliers yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add supplier' })).toBeInTheDocument();
  });

  it('lists active suppliers and reveals inactive ones on request', async () => {
    apiMock.mockResolvedValue([supplier(), supplier({ Id: 's2', Name: 'Old Threads', IsActive: false })]);
    render(<><SupplierManager canManage /><Toaster /></>);
    expect(await screen.findByText('Lagos Fabrics')).toBeInTheDocument();
    expect(screen.queryByText('Old Threads')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show inactive suppliers'));
    expect(screen.getByText('Old Threads')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('refuses a missing name or a bad email without calling the API', async () => {
    apiMock.mockResolvedValue([]);
    render(<><SupplierManager canManage /><Toaster /></>);
    await screen.findByText('No suppliers yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByText('Enter the supplier name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kano Dyes' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByText(/valid email address/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('adds a supplier, sending blank optional fields as null, and reloads', async () => {
    let added = false;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') { added = true; return {}; }
      return added ? [supplier({ Name: 'Kano Dyes' })] : [];
    });
    render(<><SupplierManager canManage /><Toaster /></>);
    await screen.findByText('No suppliers yet.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Kano Dyes ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByText('Supplier added.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/suppliers', { method: 'POST', json: { name: 'Kano Dyes', contactName: null, email: null, phone: null, address: null, notes: null } });
    expect(await screen.findByText('Kano Dyes')).toBeInTheDocument();
  });

  it('edits a supplier in the same form', async () => {
    apiMock.mockResolvedValue([supplier()]);
    render(<><SupplierManager canManage /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Lagos Fabrics' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Lagos Fabrics');
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+2348099990000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save supplier' }));
    expect(await screen.findByText('Supplier updated.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/suppliers/s1', { method: 'PATCH', json: expect.objectContaining({ name: 'Lagos Fabrics', phone: '+2348099990000' }) });
  });

  it('deactivates a supplier', async () => {
    apiMock.mockResolvedValue([supplier()]);
    render(<><SupplierManager canManage /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Lagos Fabrics' }));
    expect(await screen.findByText('Supplier deactivated.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/suppliers/s1', { method: 'PATCH', json: { isActive: false } });
  });

  it('shows the list but no form or buttons without inventory.manage', async () => {
    apiMock.mockResolvedValue([supplier()]);
    render(<><SupplierManager canManage={false} /><Toaster /></>);
    expect(await screen.findByText('Lagos Fabrics')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add supplier' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit|Deactivate/ })).not.toBeInTheDocument();
  });

  it('shows a load error with a working retry, and a server refusal on save', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Server error.')).mockResolvedValueOnce([]);
    render(<><SupplierManager canManage /><Toaster /></>);
    expect(await screen.findByText('Server error.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading suppliers' }));
    await screen.findByText('No suppliers yet.');
    apiMock.mockRejectedValueOnce(new ApiError(400, 'One or more fields are invalid.', 'validation_failed'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('One or more fields are invalid.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add supplier' })).toBeEnabled());
  });
});
