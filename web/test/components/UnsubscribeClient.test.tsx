// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { UnsubscribeClient } from '@/components/app/UnsubscribeClient';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const preview = (over = {}) => ({ businessName: 'Ada Tailors', channel: 'SMS', maskedAddress: '+234****5678', alreadyOptedOut: false, ...over });
const TOKEN = 'payload_abc.signature_xyz-1234567890';

beforeEach(() => {
  apiMock.mockReset();
  window.history.replaceState(null, '', `/unsubscribe#${TOKEN}`);
});

describe('UnsubscribeClient', () => {
  it('shows an invalid-link notice, and calls nothing, when the link has no token', async () => {
    window.history.replaceState(null, '', '/unsubscribe');
    render(<UnsubscribeClient />);
    expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('previews the link, removes the token from the address bar, and changes nothing until the person confirms', async () => {
    apiMock.mockResolvedValue(preview());
    render(<UnsubscribeClient />);
    expect(screen.getByText('Checking your link…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Stop messages from Ada Tailors?' })).toBeInTheDocument();
    expect(screen.getByText(/text messages at \+234\*\*\*\*5678/)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith('/api/messaging/unsubscribe/preview', { method: 'POST', json: { token: TOKEN } });
  });

  it('confirms with the same token and then shows the done state', async () => {
    apiMock.mockResolvedValueOnce(preview()).mockResolvedValueOnce({ optedOut: true });
    render(<UnsubscribeClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, stop messages' }));
    expect(await screen.findByRole('heading', { name: 'You are unsubscribed' })).toBeInTheDocument();
    expect(apiMock).toHaveBeenLastCalledWith('/api/messaging/unsubscribe/confirm', { method: 'POST', json: { token: TOKEN } });
    expect(screen.queryByRole('button', { name: 'Yes, stop messages' })).not.toBeInTheDocument();
  });

  it('says so, with no button, when the customer is already unsubscribed', async () => {
    apiMock.mockResolvedValue(preview({ alreadyOptedOut: true, channel: 'WhatsApp' }));
    render(<UnsubscribeClient />);
    expect(await screen.findByRole('heading', { name: 'You are already unsubscribed' })).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp messages/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the invalid-link notice when the server does not recognise the link', async () => {
    apiMock.mockRejectedValue(new ApiError(404, 'Not found.', 'unsubscribe_link_invalid'));
    render(<UnsubscribeClient />);
    expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeInTheDocument();
  });

  it('offers a retry when the preview fails for another reason, then recovers', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(429, 'Too many attempts.', undefined)).mockResolvedValueOnce(preview());
    render(<UnsubscribeClient />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Stop messages from Ada Tailors?' })).toBeInTheDocument();
    expect(apiMock).toHaveBeenLastCalledWith('/api/messaging/unsubscribe/preview', { method: 'POST', json: { token: TOKEN } });
  });

  it('keeps the confirm button and shows the error when confirming fails', async () => {
    apiMock.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new ApiError(500, 'Server error.', undefined));
    render(<UnsubscribeClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, stop messages' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Yes, stop messages' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'You are unsubscribed' })).not.toBeInTheDocument();
  });
});
