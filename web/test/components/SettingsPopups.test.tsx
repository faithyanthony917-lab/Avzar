// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { NOTIFICATION_CATEGORIES } from '@/lib/notifications-view-model';
import { AccountData } from '@/components/app/AccountData';
import { BrandingManager } from '@/components/app/BrandingManager';
import { BusinessScheduleManager } from '@/components/app/BusinessScheduleManager';
import { NotificationPreferencesEditor } from '@/components/app/NotificationPreferencesEditor';
import { RoleManager } from '@/components/app/RoleManager';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => { apiMock.mockReset(); refresh.mockReset(); });

const branding = { accentColor: null, logoMediaId: null, phone: null, email: null, taxNumber: null, footerNote: null };
const week = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: false, opensAt: null, closesAt: null }));
const preferences = {
  categories: NOTIFICATION_CATEGORIES.map((c) => ({ category: c.id, inApp: true, email: false, push: false })),
  quietHours: { enabled: false, startMinute: 1320, endMinute: 420 },
  pushAvailable: true,
};

describe('settings: results of an action are pop-ups', () => {
  it('confirms saved branding with a success pop-up and shows no inline message', async () => {
    apiMock.mockResolvedValue(branding);
    render(<><BrandingManager initial={branding} /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Document branding saved. New PDFs will use it.');
    expect(document.querySelector('.ap-ok')).toBeNull();
  });

  it('shows a failed branding save as an error pop-up', async () => {
    apiMock.mockRejectedValue(new ApiError(400, 'That colour is too light to print.'));
    render(<><BrandingManager initial={branding} /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That colour is too light to print.');
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeEnabled();
  });

  it('confirms an added holiday and a failed one with pop-ups', async () => {
    apiMock.mockResolvedValueOnce({ id: 'h1', date: '2026-12-25', name: 'Christmas' });
    render(<><BusinessScheduleManager initialSchedule={{ timeZoneId: 'Africa/Lagos', days: week, holidays: [] }} /><Toaster /></>);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-12-25' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Christmas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add closure date' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Holiday added.');

    apiMock.mockRejectedValueOnce(new ApiError(409, 'That date already has a closure.'));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-12-26' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Boxing Day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add closure date' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That date already has a closure.');
  });

  it('confirms saved notification preferences with a success pop-up', async () => {
    apiMock.mockResolvedValueOnce(preferences).mockResolvedValueOnce(preferences);
    render(<><NotificationPreferencesEditor /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Save preferences' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Notification preferences saved.');
  });

  it('keeps a failed page load on the page with a retry, not in a pop-up', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Could not load preferences.'));
    render(<><NotificationPreferencesEditor /><Toaster /></>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load preferences.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(document.querySelector('.ap-toasts')).toBeNull();
  });

  it('confirms a new role and shows a failed one as an error pop-up', async () => {
    apiMock.mockResolvedValueOnce({ id: 'r1', name: 'Cutter', permissions: [] });
    render(<><RoleManager roles={[]} available={[]} /><Toaster /></>);
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Cutter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Role created.');
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    apiMock.mockRejectedValueOnce(new ApiError(409, 'A role with that name exists.'));
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Cutter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A role with that name exists.');
  });

  it('keeps a check on what the person typed beside the form, not in a pop-up', () => {
    render(<><AccountData twoFactorEnabled={false} /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(document.querySelector('.ap-toasts')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows a failed data download as an error pop-up', async () => {
    apiMock.mockRejectedValue(new ApiError(500, 'Export is unavailable.'));
    render(<><AccountData twoFactorEnabled={false} /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export is unavailable.');
  });
});
