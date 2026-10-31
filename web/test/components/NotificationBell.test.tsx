// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubMatchMedia } from '../support/dom';
import type { NotificationItem, NotificationPage } from '@/lib/notifications-view-model';
import { ApiError } from '@/lib/problem';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, className, onClick }: { href: string; children: ReactNode; className?: string; onClick?: () => void }) => <a href={href} className={className} onClick={onClick}>{children}</a>,
}));

import { api } from '@/lib/client';
import { NotificationBell } from '@/components/app/NotificationBell';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1', category: 'tasks', eventType: 'task.assigned', title: 'Task assigned', body: 'You have a new task.',
    target: { kind: 'task', id: 't1' }, createdAtUtc: '2026-10-23T08:00:00Z', readAtUtc: null, isRead: false, ...over,
  };
}

type Routes = {
  count?: () => unknown;
  list?: () => NotificationPage | Promise<NotificationPage>;
  post?: (path: string, json: unknown) => unknown;
};

function route(routes: Routes) {
  apiMock.mockImplementation(async (path: string, init?: { method?: string; json?: unknown }) => {
    if (path === '/api/notifications/unread-count') {
      const value = routes.count ? routes.count() : { count: 0, capped: false };
      if (value instanceof Error) throw value;
      return value;
    }
    if (path.startsWith('/api/notifications?')) return routes.list ? routes.list() : { items: [], nextCursor: null };
    if (init?.method === 'POST') return routes.post ? routes.post(path, init.json) : undefined;
    throw new Error(`Unexpected api call ${path}`);
  });
}

const calls = (path: string) => apiMock.mock.calls.filter((call: unknown[]) => call[0] === path);

beforeEach(() => {
  apiMock.mockReset();
  stubMatchMedia(false); // wide screen: the desktop bell is the visible one
});

describe('NotificationBell visibility', () => {
  it('shows the desktop bell on a wide screen', async () => {
    route({});
    render(<NotificationBell placement="desktop" />);
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('renders nothing interactive and makes no request for the hidden placement', () => {
    route({});
    render(<NotificationBell placement="mobile" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows the mobile bell on a narrow screen and hides the desktop one', () => {
    stubMatchMedia(true);
    route({});
    const { unmount } = render(<NotificationBell placement="desktop" />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    render(<NotificationBell placement="mobile" />);
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });
});

describe('NotificationBell unread count', () => {
  it('puts the unread count in the accessible name', async () => {
    route({ count: () => ({ count: 3, capped: false }) });
    render(<NotificationBell placement="desktop" />);
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
  });

  it('shows 99+ when the server caps the count', async () => {
    route({ count: () => ({ count: 120, capped: true }) });
    render(<NotificationBell placement="desktop" />);
    expect(await screen.findByRole('button', { name: 'Notifications, 99+ unread' })).toBeInTheDocument();
  });

  it('has no badge when nothing is unread', async () => {
    route({ count: () => ({ count: 0, capped: false }) });
    render(<NotificationBell placement="desktop" />);
    await waitFor(() => expect(calls('/api/notifications/unread-count')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('polls again after 60 seconds', async () => {
    vi.useFakeTimers();
    route({ count: () => ({ count: 1, capped: false }) });
    render(<NotificationBell placement="desktop" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls('/api/notifications/unread-count')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(calls('/api/notifications/unread-count')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(calls('/api/notifications/unread-count')).toHaveLength(2);
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    route({});
    const { unmount } = render(<NotificationBell placement="desktop" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(calls('/api/notifications/unread-count')).toHaveLength(1);
  });

  it('keeps the bell usable when the count fails and says so in the panel', async () => {
    let fail = true;
    route({ count: () => (fail ? new ApiError(500, 'Count is down.') : { count: 2, capped: false }) });
    render(<NotificationBell placement="desktop" />);
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(bell);
    expect(await screen.findByText(/Unread count could not refresh/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(screen.getByText(/Unread count could not refresh/)).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
  });
});

describe('NotificationBell panel', () => {
  it('opens, loads the 10 most recent notifications and links to the target', async () => {
    route({ count: () => ({ count: 1, capped: false }), list: () => ({ items: [item()], nextCursor: null }) });
    render(<NotificationBell placement="desktop" />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    expect(bell).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    const link = await screen.findByRole('link', { name: 'Task assigned' });
    expect(link).toHaveAttribute('href', '/tasks/t1');
    expect(screen.getByText('You have a new task.')).toBeInTheDocument();
    expect(calls('/api/notifications?limit=10')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'View all notifications' })).toHaveAttribute('href', '/notifications');
    expect(screen.getByRole('link', { name: 'Preferences' })).toHaveAttribute('href', '/settings/notifications');
  });

  it('shows a loading line while the list is on its way', async () => {
    let release!: (page: NotificationPage) => void;
    route({ list: () => new Promise<NotificationPage>((resolve) => { release = resolve; }) });
    render(<NotificationBell placement="desktop" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Loading notifications…')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent notifications' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => { release({ items: [], nextCursor: null }); });
    await waitFor(() => expect(screen.queryByText('Loading notifications…')).toBeNull());
  });

  it('shows the empty state', async () => {
    route({ list: () => ({ items: [], nextCursor: null }) });
    render(<NotificationBell placement="desktop" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText(/all caught up/)).toBeInTheDocument();
  });

  it('shows a list failure with a retry that asks again', async () => {
    let fail = true;
    route({ list: () => { if (fail) throw new ApiError(500, 'Could not load.'); return { items: [item()], nextCursor: null }; } });
    render(<NotificationBell placement="desktop" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load.');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Task assigned')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('closes on Escape', async () => {
    route({});
    render(<NotificationBell placement="desktop" />);
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(bell);
    expect(await screen.findByRole('region', { name: 'Recent notifications' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Recent notifications' })).toBeNull());
    expect(bell).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks one notification read, then refreshes the count', async () => {
    let unread = 1;
    route({
      count: () => ({ count: unread, capped: false }),
      list: () => ({ items: [item()], nextCursor: null }),
      post: (path) => { if (path === '/api/notifications/n1/read') unread = 0; return {}; },
    });
    render(<NotificationBell placement="desktop" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Task assigned as read' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark Task assigned as read' })).toBeNull());
    expect(apiMock).toHaveBeenCalledWith('/api/notifications/n1/read', { method: 'POST', json: {} });
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('keeps the notification unread and shows the error when marking fails', async () => {
    route({
      count: () => ({ count: 1, capped: false }),
      list: () => ({ items: [item()], nextCursor: null }),
      post: () => { throw new ApiError(500, 'Could not save.'); },
    });
    render(<><NotificationBell placement="desktop" /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Task assigned as read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save.');
    expect(screen.getByRole('button', { name: 'Mark Task assigned as read' })).toBeEnabled();
  });

  it('marks everything read and clears the badge', async () => {
    route({
      count: () => ({ count: 2, capped: false }),
      list: () => ({ items: [item(), item({ id: 'n2', title: 'Order confirmed', target: { kind: 'order', id: 'o1' } })], nextCursor: null }),
    });
    render(<><NotificationBell placement="desktop" /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    await screen.findByText('Order confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument());
    expect(apiMock).toHaveBeenCalledWith('/api/notifications/read-all', { method: 'POST', json: {} });
    expect(screen.queryByRole('button', { name: /^Mark .* as read$/ })).toBeNull();
    // The confirmation is a pop-up and stays after the badge refreshes.
    expect(await screen.findByText('All notifications marked as read.')).toBeInTheDocument();
  });

  it('disables Mark all read when nothing is unread', async () => {
    route({ count: () => ({ count: 0, capped: false }), list: () => ({ items: [item({ isRead: true })], nextCursor: null }) });
    render(<NotificationBell placement="desktop" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    await screen.findByText('Task assigned');
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });
});
