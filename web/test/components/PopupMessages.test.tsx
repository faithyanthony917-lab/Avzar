// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { OrderActions } from '@/components/app/OrderActions';
import { StatusControl } from '@/components/app/StatusControl';
import { CustomerPortalLinkButton } from '@/components/app/CustomerPortalLinkButton';
import { Toaster } from '@/components/app/Toaster';
import type { Order } from '@/lib/order-types';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const order = (status: string) => ({ id: 'o1', status, progress: { totalTasks: 3 } }) as unknown as Order;

beforeEach(() => { apiMock.mockReset(); refresh.mockReset(); vi.stubGlobal('confirm', () => true); });

describe('results of an action are pop-ups', () => {
  it('shows a failed order action as an error pop-up and keeps the button usable', async () => {
    apiMock.mockRejectedValue(new ApiError(409, 'Cannot deliver while tasks are open.'));
    render(<><OrderActions order={order('Ready')} canManage canConfirm canEdit canManageTasks /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Mark delivered' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot deliver while tasks are open.');
    expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeEnabled();
  });

  it('keeps a check on what the person typed next to the form, not in a pop-up', () => {
    render(<><OrderActions order={order('Draft')} canManage canConfirm canEdit canManageTasks /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a cancellation reason of at least 3 characters.');
    expect(document.querySelector('.ap-toasts')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('confirms generated production tasks with a success pop-up', async () => {
    apiMock.mockResolvedValue({ tasksCreated: 4 });
    render(<><OrderActions order={{ ...order('Confirmed'), progress: { totalTasks: 0 } } as unknown as Order} canManage canConfirm canEdit canManageTasks /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Generate production tasks' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Created 4 production task(s).');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('shows a failed customer status change as an error pop-up', async () => {
    apiMock.mockRejectedValue(new ApiError(403, 'Your plan allows 25 active customers.'));
    render(<><StatusControl customerId="c1" status="Inactive" /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Mark active' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your plan allows 25 active customers.');
  });

  it('confirms a customer portal link with a success pop-up', async () => {
    apiMock.mockResolvedValue({ maskedEmail: 'a***@example.com', expiresAtUtc: '2026-12-01T00:00:00Z' });
    render(<><CustomerPortalLinkButton customerId="c1" /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Send customer portal link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Portal link queued for a***@example.com.');
  });

  it('shows a failed portal link revoke as an error pop-up', async () => {
    apiMock.mockRejectedValue(new ApiError(500, 'Could not revoke the links.'));
    render(<><CustomerPortalLinkButton customerId="c1" /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke portal links' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not revoke the links.');
  });
});
