// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { CustomerMessagingConsent, type MessagingPreference } from '@/components/app/CustomerMessagingConsent';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const listPath = '/api/customers/c1/messaging-preferences';
const pref = (over: Partial<MessagingPreference> = {}): MessagingPreference => ({
  Id: 'p1', Channel: 'SMS', Address: '+2348011112222', ConsentStatus: 'OptedIn', ConsentSource: 'staff_note', ConsentNote: 'Agreed at the fitting',
  ConsentedAtUtc: '2026-10-20T09:00:00Z', OptedOutAtUtc: null, UpdatedAtUtc: '2026-10-20T09:00:00Z', CustomerOptedOut: false, ...over,
});

beforeEach(() => { apiMock.mockReset(); });

describe('CustomerMessagingConsent', () => {
  it('shows a loading note, then the empty state and the form', async () => {
    apiMock.mockResolvedValue([]);
    render(<><CustomerMessagingConsent customerId="c1" canManage /><Toaster /></>);
    expect(screen.getByText('Loading message consent…')).toBeInTheDocument();
    expect(await screen.findByText('No message consent recorded for this customer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save consent' })).toBeInTheDocument();
  });

  it('lists each number with its status and note, and locks a customer\'s own opt-out', async () => {
    apiMock.mockResolvedValue([pref(), pref({ Id: 'p2', Address: '+2348033334444', ConsentStatus: 'OptedOut', ConsentNote: null, OptedOutAtUtc: '2026-10-21T09:00:00Z', ConsentSource: 'customer_link', CustomerOptedOut: true })]);
    render(<><CustomerMessagingConsent customerId="c1" canManage /><Toaster /></>);
    expect(await screen.findByText('SMS +2348011112222')).toBeInTheDocument();
    expect(screen.getByText('Note: Agreed at the fitting')).toBeInTheDocument();
    expect(screen.getByText(/Only the customer can opt back in/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Record op/ })).toHaveLength(1);
  });

  it('shows the list but no form to someone who cannot manage customers', async () => {
    apiMock.mockResolvedValue([pref()]);
    render(<><CustomerMessagingConsent customerId="c1" canManage={false} /><Toaster /></>);
    expect(await screen.findByText('SMS +2348011112222')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save consent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record op/ })).not.toBeInTheDocument();
  });

  it('refuses an opt-in without a note and a bad number, without calling the API', async () => {
    apiMock.mockResolvedValue([]);
    render(<><CustomerMessagingConsent customerId="c1" canManage /><Toaster /></>);
    await screen.findByText('No message consent recorded for this customer.');
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save consent' }));
    expect(await screen.findByText(/international phone number/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+234 801 111 2222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save consent' }));
    expect(await screen.findByText(/note of at least 5 characters/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('records an opt-in with its note, says so, and reloads the list', async () => {
    let saved = false;
    apiMock.mockImplementation(async (path: string, init?: { method?: string; json?: unknown }) => {
      if (path === listPath) return saved ? [pref()] : [];
      if (path === `${listPath}/SMS` && init?.method === 'PUT') { saved = true; return {}; }
      throw new Error(`unexpected ${path}`);
    });
    render(<><CustomerMessagingConsent customerId="c1" canManage /><Toaster /></>);
    await screen.findByText('No message consent recorded for this customer.');
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+234 801 111 2222' } });
    fireEvent.change(screen.getByLabelText(/Note \(required\)/), { target: { value: 'Agreed at the fitting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save consent' }));
    expect(await screen.findByText('Opt-in recorded.')).toBeInTheDocument();
    expect(await screen.findByText('SMS +2348011112222')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(`${listPath}/SMS`, { method: 'PUT', json: { address: '+2348011112222', consent: 'OptedIn', note: 'Agreed at the fitting' } });
  });

  it('shows the server\'s refusal and stays usable', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') throw new ApiError(409, 'This customer opted out of messages themselves. Only the customer can opt back in.', 'customer_opted_out');
      return [];
    });
    render(<><CustomerMessagingConsent customerId="c1" canManage /><Toaster /></>);
    await screen.findByText('No message consent recorded for this customer.');
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+2348011112222' } });
    fireEvent.change(screen.getByLabelText(/Note \(required\)/), { target: { value: 'Agreed at the fitting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save consent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/opted out of messages themselves/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save consent' })).toBeEnabled());
  });

  it('shows a load error with a retry that works', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Server error.')).mockResolvedValueOnce([pref()]);
    render(<><CustomerMessagingConsent customerId="c1" canManage={false} /><Toaster /></>);
    expect(await screen.findByText('Server error.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading consent' }));
    expect(await screen.findByText('SMS +2348011112222')).toBeInTheDocument();
  });
});
