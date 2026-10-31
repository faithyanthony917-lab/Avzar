// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { WorkerCalendarFeeds } from '@/components/app/WorkerCalendarFeeds';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const feed = (over: Partial<{ id: string; revokedAtUtc: string | null; lastUsedAtUtc: string | null }> = {}) => ({
  id: 'f1', createdAtUtc: '2026-10-20T09:00:00Z', lastUsedAtUtc: null, revokedAtUtc: null, expiresAtUtc: null, ...over,
});
const listPath = '/api/workers/m1/schedule/calendar-feeds';

const renderFeeds = () => render(<><WorkerCalendarFeeds membershipId="m1" workerName="Ada" /><Toaster /></>);

beforeEach(() => { apiMock.mockReset(); });

describe('WorkerCalendarFeeds', () => {
  it('shows a loading note, then the empty state', async () => {
    apiMock.mockResolvedValue([]);
    renderFeeds();
    expect(screen.getByText('Loading calendar links…')).toBeInTheDocument();
    expect(await screen.findByText('No active calendar link.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Calendar link for Ada' })).toBeInTheDocument();
    expect(screen.getByText(/Appointment notes are never included/)).toBeInTheDocument();
  });

  it('lists active links by date and counts stopped ones, without showing any link', async () => {
    apiMock.mockResolvedValue([feed({ lastUsedAtUtc: '2026-10-24T10:00:00Z' }), feed({ id: 'f2', revokedAtUtc: '2026-10-22T10:00:00Z' })]);
    renderFeeds();
    expect(await screen.findByText(/last used/)).toBeInTheDocument();
    expect(screen.getByText('1 earlier link was stopped.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Calendar link')).not.toBeInTheDocument();
  });

  it('makes a link, shows it once through this site, and reloads the list', async () => {
    let made = false;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === listPath) return made ? [feed()] : [];
      if (path === '/api/workers/m1/schedule/calendar-feed' && init?.method === 'POST') { made = true; return { id: 'f1', urlPath: '/api/calendar-feeds/tok123.ics', token: 'tok123' }; }
      throw new Error(`unexpected ${path}`);
    });
    renderFeeds();
    await screen.findByText('No active calendar link.');
    fireEvent.click(screen.getByRole('button', { name: 'Make a calendar link' }));
    const input = await screen.findByLabelText('Calendar link');
    expect(input).toHaveValue(`${window.location.origin}/backend/api/calendar-feeds/tok123.ics`);
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(await screen.findByText(/not used yet/)).toBeInTheDocument();
  });

  it('copies the link and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === listPath) return [];
      if (init?.method === 'POST') return { id: 'f1', urlPath: '/api/calendar-feeds/tok123.ics', token: 'tok123' };
      throw new Error(`unexpected ${path}`);
    });
    renderFeeds();
    await screen.findByText('No active calendar link.');
    fireEvent.click(screen.getByRole('button', { name: 'Make a calendar link' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(await screen.findByText('Link copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/backend/api/calendar-feeds/tok123.ics'));
  });

  it('stops a link, hides the shown link and confirms', async () => {
    let stopped = false;
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === listPath) return [feed({ revokedAtUtc: stopped ? '2026-10-25T10:00:00Z' : null })];
      if (init?.method === 'DELETE') { stopped = true; return undefined; }
      throw new Error(`unexpected ${path}`);
    });
    renderFeeds();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop this link' }));
    // The result of stopping a link is a pop-up, not text inside the page.
    expect(await screen.findByRole('status')).toHaveTextContent(/Calendar link stopped/);
    expect(await screen.findByText('No active calendar link.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/workers/m1/schedule/calendar-feed/f1', { method: 'DELETE' });
  });

  it('shows a failed load and a failed create as errors, and stays usable', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === listPath) throw new ApiError(400, 'no list');
      if (init?.method === 'POST') throw new ApiError(400, 'no create');
      throw new Error(`unexpected ${path}`);
    });
    renderFeeds();
    // A failed load stays on the page: there is nothing else to show in its place.
    expect(await screen.findByRole('alert')).toHaveTextContent('no list');
    fireEvent.click(screen.getByRole('button', { name: 'Make a calendar link' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/workers/m1/schedule/calendar-feed', { method: 'POST' }));
    // A failed action is a pop-up.
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent('no create');
    expect(screen.queryByLabelText('Calendar link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make a calendar link' })).toBeEnabled();
  });
});
