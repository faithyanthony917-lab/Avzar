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
import { CustomerPortalClient } from '@/components/app/CustomerPortalClient';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const redirectMock = vi.mocked(redirectTo) as unknown as ReturnType<typeof vi.fn>;
const TOKEN = 'T'.repeat(43);
const installments = [
  { sequence: 1, dueDate: '2099-01-01', amount: 50, paid: 50, outstanding: 0, status: 'Paid', overdue: false },
  { sequence: 2, dueDate: '2099-02-01', amount: 50, paid: 20, outstanding: 30, status: 'PartPaid', overdue: false },
  { sequence: 3, dueDate: '2000-03-01', amount: 50, paid: 0, outstanding: 50, status: 'Due', overdue: true },
];
const installmentPlan = (over: Record<string, unknown> = {}) => ({ state: 'Active', currencyCode: 'NGN', outstanding: 80, overdueCount: 1, installments,
  next: { sequence: 2, dueDate: '2099-02-01', amount: 30, overdue: false, payAmount: 30 }, ...over });
const invoice = (over: Record<string, unknown> = {}) => ({ id: 'inv1', number: 'INV-1', status: 'Issued', issueDate: '2026-10-20', dueDate: null, total: 150, currencyCode: 'NGN', verifiedPaid: 70, balance: 80, payments: [], installmentPlan: installmentPlan(), ...over });
const portal = (over: Record<string, unknown> = {}) => ({ customerName: 'Ada', businessName: 'Shop', currencyCode: 'NGN', onlinePaymentsEnabled: true, orders: [], invoices: [invoice()], ...over });

beforeEach(() => { apiMock.mockReset(); redirectMock.mockReset(); window.history.replaceState(null, '', `/customer-portal#${TOKEN}`); });

describe('customer portal: payment plan', () => {
  it('shows the schedule with a status for each installment, overdue included', async () => {
    apiMock.mockResolvedValueOnce(portal());
    render(<CustomerPortalClient />);
    expect(await screen.findByText('Payment plan')).toBeInTheDocument();
    expect(screen.getByText('Paid', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Part paid')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText(/30\.00 left/)).toBeInTheDocument();
  });

  it('pays the next installment: sends exactly the amount still owed on it and opens the checkout page', async () => {
    apiMock.mockResolvedValueOnce(portal()).mockResolvedValueOnce({ attempt: { authorizationUrl: 'https://checkout.example/x' }, created: true });
    render(<CustomerPortalClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Pay next installment \(.*30\.00\)/ }));
    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('https://checkout.example/x'));
    expect(apiMock).toHaveBeenLastCalledWith('/api/customer-portal/invoices/pay', { method: 'POST', json: { token: TOKEN, invoiceId: 'inv1', amount: 30 } });
  });

  it('shows the schedule but no pay button when online payments are off', async () => {
    apiMock.mockResolvedValueOnce(portal({ onlinePaymentsEnabled: false }));
    render(<CustomerPortalClient />);
    await screen.findByText('Payment plan');
    expect(screen.queryByRole('button', { name: /Pay next installment/ })).not.toBeInTheDocument();
  });

  it('shows no plan for an invoice without one, a completed plan or a void invoice, and plain Pay online still works', async () => {
    apiMock.mockResolvedValueOnce(portal({ invoices: [invoice({ installmentPlan: null }), invoice({ id: 'inv2', number: 'INV-2', installmentPlan: installmentPlan({ state: 'Completed', next: null }) }), invoice({ id: 'inv3', number: 'INV-3', status: 'Void' })] }));
    render(<CustomerPortalClient />);
    await screen.findByText('INV-1');
    expect(screen.queryByText('Payment plan')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay next installment/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Pay online' }).length).toBeGreaterThan(0);
  });

  it('an older server answer with no installmentPlan field still renders', async () => {
    const legacy = invoice(); delete (legacy as Record<string, unknown>).installmentPlan;
    apiMock.mockResolvedValueOnce(portal({ invoices: [legacy] }));
    render(<CustomerPortalClient />);
    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.queryByText('Payment plan')).not.toBeInTheDocument();
  });
});
