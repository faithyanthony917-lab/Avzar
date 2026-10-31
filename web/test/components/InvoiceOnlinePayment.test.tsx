// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { InvoiceOnlinePayment } from '@/components/app/InvoiceOnlinePayment';
import type { PaymentAttempt } from '@/lib/invoice-online-payment';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const attempt = (over: Partial<PaymentAttempt> = {}): PaymentAttempt => ({
  id: 'a1', invoiceId: 'i1', amount: 100, currencyCode: 'NGN', status: 'Pending', source: 'Staff', authorizationUrl: 'https://checkout.example/avzar_inv_1',
  expiresAtUtc: '2026-10-28T10:00:00Z', paymentId: null, createdAtUtc: '2026-10-27T10:00:00Z', ...over,
});
const props = { invoiceId: 'i1', currencyCode: 'NGN', balance: 100, canStart: true, canView: true };
const listPath = '/api/invoices/i1/online-payments';

beforeEach(() => { apiMock.mockReset(); });

describe('InvoiceOnlinePayment', () => {
  it('shows a loading note, then the empty state', async () => {
    apiMock.mockResolvedValue({ items: [] });
    render(<InvoiceOnlinePayment {...props} />);
    expect(screen.getByText('Loading online payments…')).toBeInTheDocument();
    expect(await screen.findByText('No online payments started for this invoice.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(listPath);
  });

  it('lists attempts with a readable status and who started them', async () => {
    apiMock.mockResolvedValue({ items: [attempt(), attempt({ id: 'a2', status: 'Paid', source: 'Portal', authorizationUrl: null }), attempt({ id: 'a3', status: 'NeedsReview', authorizationUrl: null })] });
    render(<InvoiceOnlinePayment {...props} />);
    expect(await screen.findByText('Waiting for payment')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Customer')).toBeInTheDocument();
    expect(screen.getByText(/Refund or reassign the money/)).toBeInTheDocument();
  });

  it('shows an error when the list cannot be loaded, and the form still works', async () => {
    apiMock.mockRejectedValue(new ApiError(500, 'The server had a problem.'));
    render(<InvoiceOnlinePayment {...props} />);
    expect(await screen.findByText('The server had a problem.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create payment link' })).toBeInTheDocument();
  });

  it('makes a link for the whole balance, shows it, and reloads the list', async () => {
    apiMock.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ attempt: attempt(), created: true }).mockResolvedValueOnce({ items: [attempt()] });
    render(<InvoiceOnlinePayment {...props} />);
    await screen.findByText('No online payments started for this invoice.');
    fireEvent.click(screen.getByRole('button', { name: 'Create payment link' }));
    const field = await screen.findByLabelText('Payment link');
    expect(field).toHaveValue('https://checkout.example/avzar_inv_1');
    const call = apiMock.mock.calls[1]!;
    expect(call[0]).toBe('/api/invoices/i1/online-payment');
    expect(call[1].method).toBe('POST');
    expect(call[1].json).toBeUndefined();
    expect(typeof call[1].idempotencyKey).toBe('string');
    expect(await screen.findByText('Waiting for payment')).toBeInTheDocument();
  });

  it('refuses an amount above the balance without calling the API, and sends a valid part amount', async () => {
    apiMock.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ attempt: attempt({ amount: 40 }), created: true }).mockResolvedValueOnce({ items: [] });
    render(<InvoiceOnlinePayment {...props} />);
    await screen.findByText('No online payments started for this invoice.');
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create payment link' }));
    expect(await screen.findByText(/not more than the balance/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create payment link' }));
    await screen.findByLabelText('Payment link');
    expect(apiMock.mock.calls[1]![1].json).toEqual({ amount: 40 });
  });

  it('points to Settings when online payments are not set up', async () => {
    apiMock.mockResolvedValueOnce({ items: [] }).mockRejectedValueOnce(new ApiError(409, 'x', 'online_payments_not_set_up'));
    render(<InvoiceOnlinePayment {...props} />);
    await screen.findByText('No online payments started for this invoice.');
    fireEvent.click(screen.getByRole('button', { name: 'Create payment link' }));
    expect(await screen.findByText(/Add a payout account in Settings first/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings');
  });

  it('says a customer email is needed', async () => {
    apiMock.mockResolvedValueOnce({ items: [] }).mockRejectedValueOnce(new ApiError(409, 'x', 'customer_email_required'));
    render(<InvoiceOnlinePayment {...props} />);
    await screen.findByText('No online payments started for this invoice.');
    fireEvent.click(screen.getByRole('button', { name: 'Create payment link' }));
    expect(await screen.findByText(/Add an email address to this customer/)).toBeInTheDocument();
  });

  it('copies a link from the list', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    apiMock.mockResolvedValue({ items: [attempt()] });
    render(<InvoiceOnlinePayment {...props} canStart={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('https://checkout.example/avzar_inv_1');
  });

  it('shows only the list to someone who cannot record payments, only the form to someone who cannot view them, and nothing to neither', async () => {
    apiMock.mockResolvedValue({ items: [] });
    const { unmount } = render(<InvoiceOnlinePayment {...props} canStart={false} />);
    await screen.findByText('No online payments started for this invoice.');
    expect(screen.queryByRole('button', { name: 'Create payment link' })).not.toBeInTheDocument();
    unmount();
    apiMock.mockReset();
    const second = render(<InvoiceOnlinePayment {...props} canView={false} />);
    expect(screen.getByRole('button', { name: 'Create payment link' })).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
    second.unmount();
    const third = render(<InvoiceOnlinePayment {...props} canStart={false} canView={false} />);
    expect(third.container).toBeEmptyDOMElement();
  });
});
