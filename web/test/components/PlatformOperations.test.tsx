// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../support/dom';
import { ApiError } from '@/lib/problem';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { PlatformOperations } from '@/components/app/PlatformOperations';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const confirmMock = vi.fn();

type Kind = 'notification' | 'push' | 'worker-summary' | 'appointment-reminder' | 'email';
function job(id: string, over: Partial<{ kind: Kind; status: string; eventType: string; lastError: string | null }> = {}) {
  return {
    kind: 'notification' as Kind, id, businessId: 'b1', eventType: `event.${id}`, status: 'Failed', attempts: 3,
    nextAttemptUtc: null, createdAtUtc: '2026-10-23T08:00:00Z', lastError: 'Boom', ...over,
  };
}
const flag = (key: string, enabled = false) => ({ key, description: `About ${key}`, enabled, updatedAtUtc: null, updatedByEmail: null });
const jobsUrl = (status: string) => `/api/platform-admin/background-jobs?limit=250${status ? `&status=${status}` : ''}`;
const jobCalls = () => apiMock.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('/api/platform-admin/background-jobs?')).map((c: unknown[]) => String(c[0]));

function show(jobs = [job('j1')], flags = [flag('beta_x')]) {
  return render(<><PlatformOperations initialFlags={flags} initialJobs={jobs} /><Toaster /></>);
}

beforeEach(() => {
  apiMock.mockReset();
  confirmMock.mockReset();
  vi.stubGlobal('confirm', confirmMock);
  window.confirm = confirmMock;
});

describe('background jobs list', () => {
  it('shows the rows it was given while it checks for fresh ones', async () => {
    const gate = deferred<{ items: ReturnType<typeof job>[] }>();
    apiMock.mockReturnValue(gate.promise);
    show();
    expect(screen.getByText('event.j1')).toBeInTheDocument();
    expect(screen.getByText('Loading jobs…')).toBeInTheDocument();
    expect(jobCalls()).toEqual([jobsUrl('Failed')]);
    gate.resolve({ items: [job('j2')] });
    expect(await screen.findByText('event.j2')).toBeInTheDocument();
    expect(screen.queryByText('event.j1')).toBeNull();
    expect(screen.queryByText('Loading jobs…')).toBeNull();
  });

  it('hides rows from the old filter and shows a loading line while a new filter loads', async () => {
    apiMock.mockResolvedValueOnce({ items: [job('j1')] });
    show();
    await waitFor(() => expect(screen.queryByText('Loading jobs…')).toBeNull());
    const gate = deferred<{ items: ReturnType<typeof job>[] }>();
    apiMock.mockReturnValueOnce(gate.promise);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Pending' } });
    expect(await screen.findByText('Loading jobs…')).toBeInTheDocument();
    expect(screen.queryByText('event.j1')).toBeNull();
    expect(screen.getByLabelText('Status')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
    gate.resolve({ items: [job('p1', { status: 'Pending' })] });
    expect(await screen.findByText('event.p1')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeEnabled();
    expect(jobCalls()).toEqual([jobsUrl('Failed'), jobsUrl('Pending')]);
  });

  it('asks for every status when "All statuses" is chosen', async () => {
    apiMock.mockResolvedValue({ items: [] });
    show();
    await waitFor(() => expect(screen.queryByText('Loading jobs…')).toBeNull());
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } });
    await waitFor(() => expect(jobCalls()).toContain(jobsUrl('')));
  });

  it('says so when no job matches', async () => {
    apiMock.mockResolvedValue({ items: [] });
    show([]);
    expect(await screen.findByText('No jobs match this filter.')).toBeInTheDocument();
  });

  it('shows the error and no stale rows when a new filter fails to load', async () => {
    apiMock.mockResolvedValueOnce({ items: [job('j1')] });
    show();
    await waitFor(() => expect(screen.queryByText('Loading jobs…')).toBeNull());
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Jobs are unavailable.'));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Sent' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Jobs are unavailable.');
    expect(screen.queryByText('event.j1')).toBeNull();
    expect(screen.getByText(/Jobs for this filter are not loaded/)).toBeInTheDocument();
    apiMock.mockResolvedValueOnce({ items: [job('s1', { status: 'Sent' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh jobs' }));
    expect(await screen.findByText('event.s1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('retrying a failed job', () => {
  it('offers Retry only for failed notification and push jobs', async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    show([
      job('n1', { kind: 'notification' }), job('p1', { kind: 'push' }), job('e1', { kind: 'email' }),
      job('w1', { kind: 'worker-summary' }), job('s1', { kind: 'notification', status: 'Sent' }),
    ]);
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
  });

  it('does nothing when the confirmation is declined', async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    confirmMock.mockReturnValue(false);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(confirmMock).toHaveBeenCalledWith('Retry failed notification job j1?');
    expect(apiMock.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith('/retry'))).toHaveLength(0);
  });

  it('posts the job kind, confirms, and reloads the list', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockImplementation(async (path: string) => (String(path).includes('/retry') ? {} : { items: [job('j1', { kind: 'push' })] }));
    show([job('j1', { kind: 'push' })]);
    await waitFor(() => expect(screen.queryByText('Loading jobs…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('The failed job was queued for retry.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/platform-admin/background-jobs/j1/retry', { method: 'POST', json: { kind: 'push' } });
    await waitFor(() => expect(jobCalls().length).toBeGreaterThanOrEqual(2));
  });

  it('shows the server error when the retry is refused', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/retry')) throw new ApiError(409, 'That job is no longer failed.');
      return { items: [job('j1')] };
    });
    show();
    await waitFor(() => expect(screen.queryByText('Loading jobs…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That job is no longer failed.');
    expect(screen.queryByText('The failed job was queued for retry.')).toBeNull();
  });
});

describe('feature flags', () => {
  it('turns a flag on and says so', async () => {
    apiMock.mockImplementation(async (path: string) => (String(path).includes('/feature-flags/') ? { key: 'beta_x', enabled: true } : { items: [] }));
    show([], [flag('beta_x', false)]);
    const row = screen.getByText('beta_x').closest('tr') as HTMLElement;
    expect(within(row).getByText('Disabled')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('beta_x enabled.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/platform-admin/feature-flags/beta_x', { method: 'PUT', json: { enabled: true } });
    expect(within(row).getByText('Enabled')).toBeInTheDocument();
  });

  it('leaves the flag as it was and shows the error when saving fails', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/feature-flags/')) throw new ApiError(403, 'You do not have permission to do that.');
      return { items: [] };
    });
    show([], [flag('beta_x', true)]);
    const row = screen.getByText('beta_x').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that.');
    expect(within(row).getByText('Enabled')).toBeInTheDocument();
  });

  it('says so when there are no flags', async () => {
    apiMock.mockResolvedValue({ items: [] });
    show([], []);
    expect(screen.getByText('No feature flags are configured.')).toBeInTheDocument();
  });
});
