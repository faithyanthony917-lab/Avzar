// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';
import type { LeaveConflictsReport } from '@/lib/worker-today';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import { api } from '@/lib/client';
import { WorkerScheduleManager } from '@/components/app/WorkerScheduleManager';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const workers = [{ membershipId: 'm1', displayName: 'Ada', isActive: true, skills: [], openTasks: 2 }];
const pending = { id: 'l2', membershipId: 'm1', startsAtUtc: '2026-10-29T08:00:00Z', endsAtUtc: '2026-10-29T16:00:00Z', reason: 'Wedding', status: 'Pending' };
const approved = { id: 'l1', membershipId: 'm1', startsAtUtc: '2026-11-02T08:00:00Z', endsAtUtc: '2026-11-02T16:00:00Z', reason: 'Dentist', status: 'Approved' };
const conflicts: LeaveConflictsReport = {
  asOfUtc: '2026-10-26T12:00:00Z', scopedToLocations: false,
  leaves: [{
    leaveId: 'l2', membershipId: 'm1', workerName: 'Ada', startsAtUtc: pending.startsAtUtc, endsAtUtc: pending.endsAtUtc, reason: 'Wedding', status: 'Pending',
    affectedTaskCount: 2, affectedTasksTruncated: false,
    affectedTasks: [
      { taskId: 't1', title: 'Cut agbada', orderNumber: 'ORD-1', status: 'Scheduled', startUtc: '2026-10-29T09:00:00Z', endUtc: '2026-10-29T10:00:00Z' },
      { taskId: 't2', title: 'Sew agbada', orderNumber: 'ORD-1', status: 'Scheduled', startUtc: '2026-10-29T10:00:00Z', endUtc: '2026-10-29T12:00:00Z' },
    ],
  }],
};

function routes(conflictAnswer: () => unknown) {
  apiMock.mockImplementation(async (path: string) => {
    if (path.includes('/schedule/availability')) return { membershipId: 'm1', isConfigured: false, days: [] };
    if (path.includes('/schedule/leave-requests/pending')) return [pending];
    if (path.includes('/schedule/leave?')) return [approved];
    if (path.includes('/schedule/calendar-feeds')) return [];
    if (path.includes('/schedule/calendar')) return [];
    if (path === '/api/production/leave-conflicts') return conflictAnswer();
    throw new Error(`unexpected request ${path}`);
  });
}

beforeEach(() => { apiMock.mockReset(); });

describe('WorkerScheduleManager leave collision flags', () => {
  it('marks the pending request that collides with planned tasks, and links them', async () => {
    routes(() => conflicts);
    render(<WorkerScheduleManager initialWorkers={workers} canManage canRequest={false} timeZoneId="Africa/Lagos" />);
    expect(await screen.findByText('Collides with 2 planned tasks')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cut agbada' })).toHaveAttribute('href', '/tasks/t1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getAllByText(/Collides with/)).toHaveLength(1); // the approved leave l1 has no collision
  });

  it('still lets the manager review leave when the collisions cannot be loaded', async () => {
    routes(() => { throw new Error('boom'); });
    render(<WorkerScheduleManager initialWorkers={workers} canManage canRequest={false} timeZoneId="Africa/Lagos" />);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByText(/Collides with/)).toBeNull();
  });

  it('does not ask for collisions when the user cannot manage workers', async () => {
    routes(() => conflicts);
    render(<WorkerScheduleManager initialWorkers={workers} canManage={false} canRequest timeZoneId="Africa/Lagos" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('/schedule/calendar')));
    expect(apiMock.mock.calls.map((call) => call[0])).not.toContain('/api/production/leave-conflicts');
    expect(screen.queryByText(/Collides with/)).toBeNull();
  });
});
