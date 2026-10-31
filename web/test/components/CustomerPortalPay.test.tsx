// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));
vi.mock('@/lib/navigate', () => ({ redirectTo: vi.fn() }));
vi.mock('@/components/app/CustomerPortalQuotations', () => ({ CustomerPortalQuotations: () => null }));
vi.mock('@/components/app/CustomerPrivacyRequestForm', () => ({ CustomerPrivacyRequestForm: () => null }));

import { api } from '@/lib/client';
import { redirectTo } from '@/lib/navigate';
import { ApiError } from '@/lib/problem';
import { CustomerPortalClient } from '@/components/app/CustomerPortalClient';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const redirectMock = vi.mocked(redirectTo) as unknown as ReturnType<typeof vi.fn>;
const TOKEN = 'T'.repeat(43);
const invoice = (over: Record<string, unknown> = {}) => ({ id: 'inv1', number: 'INV-1', status: 'Issued', issueDate: '2026-10-20', dueDate: null, total: 100, currencyCode: 'NGN', verifiedPaid: 0, balance: 100, payments: [], ...over });
const portal = (over: Record<string, unknown> = {}) => ({ customerName: 'Ada', businessName: 'Shop', currencyCode: 'NGN', onlinePaymentsEnabled: true, orders: [], invoices: [invoice()], ...over });

beforeEach(() => { apiMock.mockReset(); redirectMock.mockReset(); window.history.replaceState(null, '', `/customer-portal#${TOKEN}`); });

describe('customer portal: pay online', () => {
  it('offers Pay online on an issued invoice with a balance, and sends the customer to the checkout page', async () => {
    apiMock.mockResolvedValueOnce(portal()).mockResolvedValueOnce({ attempt: { authorizationUrl: 'https://checkout.example/x' }, created: true });
    render(<CustomerPortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pay online' }));
    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('https://checkout.example/x'));
    expect(apiMock).toHaveBeenLastCalledWith('/api/customer-portal/invoices/pay', { method: 'POST', json: { token: TOKEN, invoiceId: 'inv1' } });
  });

  it('shows no button when the business has not set up online payments', async () => {
    apiMock.mockResolvedValueOnce(portal({ onlinePaymentsEnabled: false }));
    render(<CustomerPortalClient />);
    await screen.findByText('INV-1');
    expect(screen.queryByRole('button', { name: 'Pay online' })).not.toBeInTheDocument();
  });

  it('shows no button for a paid, draft or void invoice', async () => {
    apiMock.mockResolvedValueOnce(portal({ invoices: [invoice({ balance: 0, verifiedPaid: 100 }), invoice({ id: 'inv2', number: null, status: 'Draft' }), invoice({ id: 'inv3', number: 'INV-3', status: 'Void' })] }));
    render(<CustomerPortalClient />);
    await screen.findByText('INV-1');
    expect(screen.queryByRole('button', { name: 'Pay online' })).not.toBeInTheDocument();
  });

  it('shows the refusal next to the invoice and lets the customer try again', async () => {
    apiMock.mockResolvedValueOnce(portal()).mockRejectedValueOnce(new ApiError(409, 'Online payments are not set up for this business yet.'));
    render(<CustomerPortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pay online' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Online payments are not set up for this business yet.');
    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pay online' })).not.toBeDisabled();
  });

  it('does not redirect when no checkout address comes back', async () => {
    apiMock.mockResolvedValueOnce(portal()).mockResolvedValueOnce({ attempt: { authorizationUrl: null }, created: false });
    render(<CustomerPortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pay online' }));
    expect(await screen.findByText('The payment page could not be opened. Try again.')).toBeInTheDocument();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('shows a thank-you page, not an error, when the customer returns from the checkout without the link token', async () => {
    window.history.replaceState(null, '', '/customer-portal?payment=complete');
    render(<CustomerPortalClient />);
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    expect(screen.queryByText('Customer portal unavailable')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
