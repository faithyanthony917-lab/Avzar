// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { PaymentAccountPanel } from '@/components/app/PaymentAccountPanel';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const banks = { items: [{ name: 'Test Bank', code: '044' }, { name: 'Other Bank', code: '058' }] };

beforeEach(() => { apiMock.mockReset(); });

describe('PaymentAccountPanel', () => {
  it('shows a loading note, then "Not set up" with a set-up button', async () => {
    apiMock.mockResolvedValue({ configured: false });
    render(<><PaymentAccountPanel /><Toaster /></>);
    expect(screen.getByText('Loading payout account…')).toBeInTheDocument();
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up payout account' })).toBeInTheDocument();
  });

  it('says so when the account is already set up', async () => {
    apiMock.mockResolvedValue({ configured: true });
    render(<><PaymentAccountPanel /><Toaster /></>);
    expect(await screen.findByText('Payout account set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change payout account' })).toBeInTheDocument();
  });

  it('shows an error when the status cannot be loaded', async () => {
    apiMock.mockRejectedValue(new ApiError(500, 'The server had a problem.'));
    render(<><PaymentAccountPanel /><Toaster /></>);
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem.');
    expect(screen.queryByRole('button', { name: /payout account/ })).not.toBeInTheDocument();
  });

  it('loads the bank list on demand and refuses a missing bank or a bad number without calling the API', async () => {
    apiMock.mockResolvedValueOnce({ configured: false }).mockResolvedValueOnce(banks);
    render(<><PaymentAccountPanel /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up payout account' }));
    expect(await screen.findByRole('option', { name: 'Test Bank' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save payout account' }));
    expect(await screen.findByText('Choose your bank.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: '044' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save payout account' }));
    expect(await screen.findByText('Enter the 10-digit account number.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it('saves the account, clears the number and says it worked', async () => {
    apiMock.mockResolvedValueOnce({ configured: false }).mockResolvedValueOnce(banks).mockResolvedValueOnce({ configured: true, accountName: 'TEST ACCOUNT' });
    render(<><PaymentAccountPanel /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up payout account' }));
    await screen.findByRole('option', { name: 'Test Bank' });
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: '044' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '0123 456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save payout account' }));
    expect(await screen.findByText(/Payout account saved/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenLastCalledWith('/api/business/payment-account', { method: 'PUT', json: { bankCode: '044', accountNumber: '0123456789' } });
    expect(screen.getByText('Payout account set up')).toBeInTheDocument();
    expect(screen.queryByLabelText('Account number')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('0123456789');
  });

  it('keeps the form open and shows the refusal when saving fails', async () => {
    apiMock.mockResolvedValueOnce({ configured: false }).mockResolvedValueOnce(banks).mockRejectedValueOnce(new ApiError(400, 'That bank account could not be verified.'));
    render(<><PaymentAccountPanel /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up payout account' }));
    await screen.findByRole('option', { name: 'Test Bank' });
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: '044' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '0123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save payout account' }));
    expect(await screen.findByText('That bank account could not be verified.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save payout account' })).not.toBeDisabled());
  });

  it('shows an error when the bank list cannot be loaded', async () => {
    apiMock.mockResolvedValueOnce({ configured: false }).mockRejectedValueOnce(new ApiError(503, 'Online payments are not available right now.'));
    render(<><PaymentAccountPanel /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up payout account' }));
    expect(await screen.findByText('Online payments are not available right now.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save payout account' })).not.toBeInTheDocument();
  });
});
