// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { PlatformBusinessDetailView } from '@/components/app/PlatformBusinessDetailView';
import { PlatformBusinessSuspension } from '@/components/app/PlatformBusinessSuspension';
import type { PlatformBusinessDetail } from '@/lib/platformAdmin';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const confirmMock = vi.fn();
beforeEach(() => { apiMock.mockReset(); confirmMock.mockReset(); window.confirm = confirmMock as unknown as typeof window.confirm; });

const props = { businessId: 'b1', businessName: 'Shop 1', isActive: true, suspendedReason: null, isOwnBusiness: false };

describe('PlatformBusinessSuspension', () => {
  it('keeps the button off until a reason of at least three characters is typed', () => {
    render(<PlatformBusinessSuspension {...props} />);
    const button = screen.getByRole('button', { name: 'Suspend this business' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: ' ab ' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Chargeback dispute' } });
    expect(button.disabled).toBe(false);
  });

  it('asks for confirmation, then posts the trimmed reason and tells the screen to reload', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockResolvedValue({ id: 'b1', isActive: false });
    const onChanged = vi.fn();
    render(<PlatformBusinessSuspension {...props} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Chargeback dispute  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend this business' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledWith('/api/platform-admin/businesses/b1/suspend', { method: 'POST', json: { reason: 'Chargeback dispute' } });
  });

  it('does nothing when the confirmation is declined', () => {
    confirmMock.mockReturnValue(false);
    render(<PlatformBusinessSuspension {...props} />);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Chargeback dispute' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend this business' }));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows the server\'s message when the call fails, and does not reload', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockRejectedValue(new ApiError(409, 'This business is already suspended.', 'already_suspended'));
    const onChanged = vi.fn();
    render(<PlatformBusinessSuspension {...props} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Chargeback dispute' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend this business' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This business is already suspended.');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('the administrator\'s own business cannot be suspended from here', () => {
    render(<PlatformBusinessSuspension {...props} isOwnBusiness />);
    expect(screen.getByText(/cannot be suspended from here/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a suspended business shows its reason and a reactivate button that posts with no body', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockResolvedValue({ id: 'b1', isActive: true });
    const onChanged = vi.fn();
    render(<PlatformBusinessSuspension {...props} isActive={false} suspendedReason="Chargeback dispute" onChanged={onChanged} />);
    expect(screen.getByText('Reason: Chargeback dispute')).toBeTruthy();
    expect(screen.queryByLabelText(/Reason/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate this business' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith('/api/platform-admin/businesses/b1/reactivate', { method: 'POST', json: {} });
  });
});

describe('PlatformBusinessDetailView with a suspension', () => {
  const detail: PlatformBusinessDetail = {
    id: 'b1', name: 'Shop 1', contactEmail: null, currencyCode: 'NGN', timeZoneId: 'UTC', isActive: false, createdAtUtc: '2026-10-20T08:30:00Z',
    updatedAtUtc: null, suspendedAtUtc: '2026-10-31T09:05:00Z', suspendedReason: 'Chargeback dispute', owner: null, plan: null,
    usage: { activeStaff: 0, locations: 1, customers: 0, orders: 0, ordersLast30Days: 0, invoices: 0, storageBytes: 0 },
  };
  it('says when the business was suspended and offers reactivation', () => {
    render(<PlatformBusinessDetailView business={detail} />);
    expect(screen.getByText('Suspended on 2026-10-31 09:05 UTC')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reactivate this business' })).toBeTruthy();
  });
  it('an active business offers suspension, and not for the signed-in business', () => {
    const { rerender } = render(<PlatformBusinessDetailView business={{ ...detail, isActive: true, suspendedAtUtc: null, suspendedReason: null }} />);
    expect(screen.getByRole('heading', { name: 'Suspend this business' })).toBeTruthy();
    rerender(<PlatformBusinessDetailView business={{ ...detail, isActive: true }} isOwnBusiness />);
    expect(screen.queryByRole('button', { name: 'Suspend this business' })).toBeNull();
  });
});
