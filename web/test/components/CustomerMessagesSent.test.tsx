// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { CustomerMessagesSent, type CustomerMessage } from '@/components/app/CustomerMessagesSent';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const path = '/api/customers/c1/messages';
const message = (over: Partial<CustomerMessage> = {}): CustomerMessage => ({
  id: 'm1', kind: 'order.ready', channel: 'SMS', address: '+234****2222', status: 'Sent', error: null,
  createdAtUtc: '2026-10-28T09:00:00Z', sentAtUtc: '2026-10-28T09:01:00Z', ...over,
});

beforeEach(() => { apiMock.mockReset(); });

describe('CustomerMessagesSent', () => {
  it('shows a loading note, then the empty state', async () => {
    apiMock.mockResolvedValue([]);
    render(<CustomerMessagesSent customerId="c1" />);
    expect(screen.getByText('Loading messages…')).toBeInTheDocument();
    expect(await screen.findByText('No order or payment messages have been queued for this customer.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(path);
  });

  it('lists each message with its kind, status, masked number and the failure reason', async () => {
    apiMock.mockResolvedValue([
      message(),
      message({ id: 'm2', kind: 'payment.receipt', channel: 'WhatsApp', status: 'Failed', error: 'sms_http_500', sentAtUtc: null }),
      message({ id: 'm3', kind: 'order.amended', status: 'Pending', sentAtUtc: null }),
    ]);
    render(<CustomerMessagesSent customerId="c1" />);
    expect(await screen.findByText('Order ready')).toBeInTheDocument();
    expect(screen.getByText('Payment receipt')).toBeInTheDocument();
    expect(screen.getByText('Order updated')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Waiting to send')).toBeInTheDocument();
    expect(screen.getByText('Last error: sms_http_500')).toBeInTheDocument();
    expect(screen.getAllByText(/\+234\*\*\*\*2222/).length).toBeGreaterThan(0);
  });

  it('shows a failed load as an error and loads again on retry', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Could not load the messages.'));
    apiMock.mockResolvedValueOnce([message()]);
    render(<CustomerMessagesSent customerId="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the messages.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading messages' }));
    expect(await screen.findByText('Order ready')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});
