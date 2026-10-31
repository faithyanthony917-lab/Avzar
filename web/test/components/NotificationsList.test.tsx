// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../support/dom';
import type { NotificationItem, NotificationPage } from '@/lib/notifications-view-model';
import { ApiError } from '@/lib/problem';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, className, onClick }: { href: string; children: ReactNode; className?: string; onClick?: () => void }) => <a href={href} className={className} onClick={onClick}>{children}</a>,
}));

import { api } from '@/lib/client';
import { NotificationsList } from '@/components/app/NotificationsList';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;

function item(id: string, over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id, category: 'tasks', eventType: 'task.assigned', title: `Title ${id}`, body: `Body ${id}`,
    target: null, createdAtUtc: '2026-10-23T08:00:00Z', readAtUtc: null, isRead: false, ...over,
  };
}

const page = (items: NotificationItem[], nextCursor: string | null = null): NotificationPage => ({ items, nextCursor });
const listCalls = () => apiMock.mock.calls.filter((call: unknown[]) => String(call[0]).startsWith('/api/notifications?')).map((call: unknown[]) => String(call[0]));

beforeEach(() => { apiMock.mockReset(); });

describe('NotificationsList', () => {
  it('shows a loading line, then the notifications', async () => {
    const gate = deferred<NotificationPage>();
    apiMock.mockReturnValueOnce(gate.promise);
    render(<NotificationsList />);
    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
    gate.resolve(page([item('a'), item('b')]));
    expect(await screen.findByText('Title a')).toBeInTheDocument();
    expect(screen.getByText('Title b')).toBeInTheDocument();
    expect(screen.queryByText('Loading notifications…')).toBeNull();
    expect(listCalls()).toEqual(['/api/notifications?limit=20']);
  });

  it('says so when there are no notifications', async () => {
    apiMock.mockResolvedValueOnce(page([]));
    render(<NotificationsList />);
    expect(await screen.findByText('No notifications yet.')).toBeInTheDocument();
  });

  it('asks only for unread items when Unread is chosen, and has its own empty message', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')])).mockResolvedValueOnce(page([]));
    render(<NotificationsList />);
    await screen.findByText('Title a');
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
    expect(await screen.findByText('There are no unread notifications.')).toBeInTheDocument();
    expect(listCalls()).toEqual(['/api/notifications?limit=20', '/api/notifications?unread=true&limit=20']);
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters by category', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')])).mockResolvedValueOnce(page([item('o1', { category: 'orders' })]));
    render(<NotificationsList />);
    await screen.findByText('Title a');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'orders' } });
    expect(await screen.findByText('Title o1')).toBeInTheDocument();
    expect(screen.queryByText('Title a')).toBeNull();
    expect(listCalls()[1]).toBe('/api/notifications?category=orders&limit=20');
  });

  it('loads more with the cursor and appends, then hides the button on the last page', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')], 'cursor-1')).mockResolvedValueOnce(page([item('b')], null));
    render(<NotificationsList />);
    await screen.findByText('Title a');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Title b')).toBeInTheDocument();
    expect(screen.getByText('Title a')).toBeInTheDocument();
    expect(listCalls()[1]).toBe('/api/notifications?limit=20&cursor=cursor-1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows a load failure and recovers on Try again', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Could not load.')).mockResolvedValueOnce(page([item('a')]));
    render(<NotificationsList />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load.');
    expect(screen.queryByText('No notifications yet.')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Title a')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the list and shows the error when Load more fails', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')], 'c')).mockRejectedValueOnce(new ApiError(500, 'Page failed.'));
    render(<NotificationsList />);
    await screen.findByText('Title a');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Page failed.');
    expect(screen.getByText('Title a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
  });

  it('marks one notification read in place and confirms it', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')]));
    render(<><NotificationsList /><Toaster /></>);
    await screen.findByText('Title a');
    apiMock.mockResolvedValueOnce(item('a', { isRead: true, readAtUtc: '2026-10-23T09:00:00Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Title a as read' }));
    expect(await screen.findByText('Notification marked as read.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/notifications/a/read', { method: 'POST', json: {} });
    expect(screen.queryByRole('button', { name: 'Mark Title a as read' })).toBeNull();
  });

  it('shows the error and keeps the item unread when marking fails', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')]));
    render(<><NotificationsList /><Toaster /></>);
    await screen.findByText('Title a');
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Could not save.'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Title a as read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save.');
    expect(screen.getByRole('button', { name: 'Mark Title a as read' })).toBeEnabled();
  });

  it('marks all read for the chosen category and reloads', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')])).mockResolvedValueOnce(page([item('o1', { category: 'orders' })]));
    render(<><NotificationsList /><Toaster /></>);
    await screen.findByText('Title a');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'orders' } });
    await screen.findByText('Title o1');
    apiMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(page([item('o1', { category: 'orders', isRead: true })]));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    // The confirmation is a pop-up, so the reload no longer clears it.
    expect(await screen.findByText('Notifications marked as read.')).toBeInTheDocument();
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(apiMock).toHaveBeenCalledWith('/api/notifications/read-all', { method: 'POST', json: { category: 'orders' } });
    expect(listCalls()[2]).toBe('/api/notifications?category=orders&limit=20');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled());
  });

  it('marks all read without a category when none is chosen', async () => {
    apiMock.mockResolvedValueOnce(page([item('a')]));
    render(<NotificationsList />);
    await screen.findByText('Title a');
    apiMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(page([item('a', { isRead: true })]));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(apiMock).toHaveBeenCalledWith('/api/notifications/read-all', { method: 'POST', json: {} });
  });

  it('disables Mark all read when everything shown is already read', async () => {
    apiMock.mockResolvedValueOnce(page([item('a', { isRead: true })]));
    render(<NotificationsList />);
    await screen.findByText('Title a');
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });
});
