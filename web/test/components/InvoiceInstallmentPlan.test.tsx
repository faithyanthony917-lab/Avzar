// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { InvoiceInstallmentPlan } from '@/components/app/InvoiceInstallmentPlan';
import { Toaster } from '@/components/app/Toaster';
import type { InstallmentPlan } from '@/lib/installment-plan';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const PATH = '/api/invoices/i1/installment-plan';
const props = { invoiceId: 'i1', currencyCode: 'NGN', balance: 100, canMake: true, canView: true };
const row = (sequence: number, over: Record<string, unknown> = {}) => ({ sequence, dueDate: `2099-0${sequence}-01`, amount: 50, paid: 0, outstanding: 50, status: 'Due', overdue: false, ...over });
const plan = (over: Partial<InstallmentPlan> = {}): InstallmentPlan => ({
  id: 'p1', state: 'Active', currencyCode: 'NGN', outstanding: 100, overdueCount: 0, invoiceBalance: 100, matchesInvoice: true,
  installments: [row(1), row(2)] as InstallmentPlan['installments'], next: { sequence: 1, dueDate: '2099-01-01', amount: 50, overdue: false, payAmount: 50 }, ...over,
});

beforeEach(() => { apiMock.mockReset(); });

describe('InvoiceInstallmentPlan', () => {
  it('shows a loading note, then the empty state with the create form', async () => {
    apiMock.mockResolvedValue({ plan: null });
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    expect(screen.getByText('Loading payment plan…')).toBeInTheDocument();
    expect(await screen.findByText('No payment plan for this invoice.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(PATH);
    expect(screen.getByRole('button', { name: 'Make payment plan' })).toBeInTheDocument();
  });

  it('shows an error when the plan cannot be loaded', async () => {
    apiMock.mockRejectedValue(new ApiError(500, 'The server had a problem.'));
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    expect(await screen.findByText('The server had a problem.')).toBeInTheDocument();
  });

  it('lists the installments with badges, marking an overdue one', async () => {
    apiMock.mockResolvedValue({ plan: plan({ overdueCount: 1, installments: [row(1, { status: 'Paid', paid: 50, outstanding: 0 }), row(2, { overdue: true })] as InstallmentPlan['installments'] }) });
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    expect(await screen.findByText('Paid', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText(/1 overdue/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make payment plan' })).not.toBeInTheDocument();
  });

  it('warns when the invoice owes something the schedule does not expect', async () => {
    apiMock.mockResolvedValue({ plan: plan({ matchesInvoice: false, invoiceBalance: 130 }) });
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    expect(await screen.findByText(/not what the schedule expects/)).toBeInTheDocument();
  });

  it('refuses bad equal-parts input without calling the API', async () => {
    apiMock.mockResolvedValue({ plan: null });
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    await screen.findByText('No payment plan for this invoice.');
    fireEvent.click(screen.getByRole('button', { name: 'Make payment plan' }));
    expect(await screen.findByText('Choose the first due date.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('First due date'), { target: { value: '2099-01-01' } });
    fireEvent.change(screen.getByLabelText('Number of parts'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make payment plan' }));
    expect(await screen.findByText('Use between 2 and 24 parts.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Number of parts'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('First due date'), { target: { value: '2000-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make payment plan' }));
    expect(await screen.findByText('The first due date cannot be in the past.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('makes an equal-parts plan and shows the saved state', async () => {
    apiMock.mockResolvedValueOnce({ plan: null }).mockResolvedValueOnce({ plan: plan(), created: true });
    const onChanged = vi.fn();
    render(<><InvoiceInstallmentPlan {...props} onChanged={onChanged} /><Toaster /></>);
    await screen.findByText('No payment plan for this invoice.');
    fireEvent.change(screen.getByLabelText('Number of parts'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('First due date'), { target: { value: '2099-01-01' } });
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'weekly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make payment plan' }));
    expect(await screen.findByText('Payment plan saved.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenLastCalledWith(PATH, { method: 'POST', json: { parts: 2, firstDueDate: '2099-01-01', interval: 'weekly' } });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getAllByText('Due', { selector: 'span' }).length).toBe(2);
  });

  it('checks a custom list on screen, then sends it', async () => {
    apiMock.mockResolvedValueOnce({ plan: null }).mockResolvedValueOnce({ plan: plan(), created: true });
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    await screen.findByText('No payment plan for this invoice.');
    fireEvent.change(screen.getByLabelText('Plan type'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Due date 1'), { target: { value: '2099-01-01' } });
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Due date 2'), { target: { value: '2099-02-01' } });
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make payment plan' }));
    expect(await screen.findByText(/add up to 90\.00 but the balance is 100\.00/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make payment plan' }));
    await screen.findByText('Payment plan saved.');
    expect(apiMock).toHaveBeenLastCalledWith(PATH, { method: 'POST', json: { installments: [{ dueDate: '2099-01-01', amount: 60 }, { dueDate: '2099-02-01', amount: 40 }] } });
  });

  it('shows the server refusal in plain language and keeps the form usable', async () => {
    apiMock.mockResolvedValueOnce({ plan: null }).mockRejectedValueOnce(new ApiError(403, 'x', 'feature_not_in_plan'));
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    await screen.findByText('No payment plan for this invoice.');
    fireEvent.change(screen.getByLabelText('First due date'), { target: { value: '2099-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make payment plan' }));
    expect(await screen.findByText(/does not include payment plans/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make payment plan' })).toBeEnabled();
  });

  it('asks for confirmation before cancelling, then cancels', async () => {
    apiMock.mockResolvedValueOnce({ plan: plan() }).mockResolvedValueOnce({ cancelled: true });
    render(<><InvoiceInstallmentPlan {...props} /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel plan' }));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/The invoice, its balance and its payments stay as they are/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the plan' }));
    expect(screen.queryByRole('button', { name: 'Yes, cancel the plan' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel the plan' }));
    expect(await screen.findByText(/Payment plan cancelled/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenLastCalledWith(PATH, { method: 'DELETE', json: {} });
    await waitFor(() => expect(screen.getByText('No payment plan for this invoice.')).toBeInTheDocument());
  });

  it('a viewer sees the plan but no create form and no cancel button', async () => {
    apiMock.mockResolvedValue({ plan: plan() });
    render(<><InvoiceInstallmentPlan {...props} canMake={false} /><Toaster /></>);
    await screen.findByText(/Still to pay on the plan/);
    expect(screen.queryByRole('button', { name: 'Cancel plan' })).not.toBeInTheDocument();
  });

  it('renders nothing without either permission', () => {
    const { container } = render(<><InvoiceInstallmentPlan {...props} canMake={false} canView={false} /><Toaster /></>);
    expect(container).toBeEmptyDOMElement();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
