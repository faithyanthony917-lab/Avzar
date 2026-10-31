// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../support/dom';
import type { Appointment } from '@/lib/fittings-view-model';
import { ApiError } from '@/lib/problem';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { AppointmentActions } from '@/components/app/FittingStatusControl';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const confirmMock = vi.fn();

const DAY = 86_400_000;
function appointment(over: Partial<Appointment> = {}): Appointment {
  const start = Date.now() + 30 * DAY;
  return {
    id: 'ap/1', type: 'Fitting', customerId: 'c1', orderId: null, locationId: 'l1', assignedMembershipId: null,
    startUtc: new Date(start).toISOString(), endUtc: new Date(start + 30 * 60_000).toISOString(),
    timeZoneId: 'UTC', status: 'Scheduled', notes: null, cancellationReason: null, ...over,
  };
}
const ended = (over: Partial<Appointment> = {}) => appointment({
  startUtc: new Date(Date.now() - 2 * DAY).toISOString(), endUtc: new Date(Date.now() - 2 * DAY + 30 * 60_000).toISOString(), ...over,
});

function show(a: Appointment) {
  return render(<><AppointmentActions appointment={a} timeZone="UTC" who="Ada" /><Toaster /></>);
}

beforeEach(() => {
  apiMock.mockReset();
  refresh.mockReset();
  confirmMock.mockReset();
  vi.stubGlobal('confirm', confirmMock);
  window.confirm = confirmMock;
});

describe('which actions are offered', () => {
  it('offers Reschedule and Cancel, but not Complete or No-show, before the appointment has ended', () => {
    show(appointment());
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'No-show' })).toBeNull();
  });

  it('offers Complete and No-show once a scheduled appointment has ended', () => {
    show(ended());
    expect(screen.getByRole('button', { name: 'Complete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No-show' })).toBeInTheDocument();
  });

  it('offers nothing for a completed appointment', () => {
    show(ended({ status: 'Completed' }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('allows only Reschedule for a cancelled appointment', () => {
    show(appointment({ status: 'Cancelled' }));
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
  });
});

describe('recording the outcome', () => {
  it('does nothing when the person declines the confirmation', async () => {
    confirmMock.mockReturnValue(false);
    show(ended());
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(confirmMock).toHaveBeenCalledWith('Mark the appointment for Ada as completed?');
    expect(apiMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('posts the status with an encoded id, confirms and refreshes the page', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockResolvedValue(undefined);
    show(ended());
    fireEvent.click(screen.getByRole('button', { name: 'No-show' }));
    expect(await screen.findByText(/^Appointment marked /)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/appointments/ap%2F1/status', { method: 'POST', json: { status: 'NoShow' } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the server error and does not refresh', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockRejectedValue(new ApiError(403, 'You do not have permission to do that.'));
    show(ended());
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables the buttons while a request is in flight', async () => {
    confirmMock.mockReturnValue(true);
    const gate = deferred<void>();
    apiMock.mockReturnValue(gate.promise);
    show(ended());
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete' })).toBeEnabled());
  });
});

describe('cancelling', () => {
  it('needs a reason of at least 3 characters before asking anything', () => {
    show(appointment());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: ' a ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a cancellation reason of at least 3 characters.');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('posts the trimmed reason, closes the form and refreshes', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockResolvedValue(undefined);
    show(appointment());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: '  Customer travelling  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByText('Appointment cancelled.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/appointments/ap%2F1/cancel', { method: 'POST', json: { reason: 'Customer travelling' } });
    expect(screen.queryByLabelText('Cancellation reason')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the form open and shows the error when the server refuses', async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockRejectedValue(new ApiError(409, 'That conflicts with the current state. Reload and try again.'));
    show(appointment());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'No longer needed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That conflicts with the current state');
    expect(screen.getByLabelText('Cancellation reason')).toHaveValue('No longer needed');
  });
});

describe('rescheduling', () => {
  function openReschedule(a = appointment()) {
    show(a);
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
  }

  it('opens with the current time and duration filled in', () => {
    const a = appointment();
    openReschedule(a);
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(30);
    expect((screen.getByLabelText('New date and time') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(screen.getByText('Time zone: UTC')).toBeInTheDocument();
  });

  it('posts the new start and end in UTC and refreshes', async () => {
    apiMock.mockResolvedValue(undefined);
    openReschedule();
    fireEvent.change(screen.getByLabelText('New date and time'), { target: { value: '2099-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new time' }));
    expect(await screen.findByText('Appointment rescheduled.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/api/appointments/ap%2F1/reschedule', {
      method: 'POST', json: { startAt: '2099-06-01T10:00:00.000Z', endAt: '2099-06-01T10:45:00.000Z' },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('New date and time')).toBeNull();
  });

  it('refuses a time in the past without calling the server', () => {
    openReschedule();
    fireEvent.change(screen.getByLabelText('New date and time'), { target: { value: '2001-01-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new time' }));
    expect(screen.getByText('An appointment must start in the future.')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('refuses an out-of-range duration without calling the server', () => {
    openReschedule();
    fireEvent.change(screen.getByLabelText('New date and time'), { target: { value: '2099-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new time' }));
    expect(screen.getByText(/Enter a whole number of minutes from/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('lists each clash the server reports, with who it clashes on', async () => {
    apiMock.mockRejectedValue(new ApiError(409, 'Conflict.', 'appointment_conflict', {}, {
      conflicts: [{ type: 'Fitting', startUtc: '2099-06-01T10:00:00.000Z', conflictOn: ['customer', 'staff'] }],
    }));
    openReschedule();
    fireEvent.change(screen.getByLabelText('New date and time'), { target: { value: '2099-06-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new time' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Fitting at .*2099.* \(customer and staff conflict\)/);
    // A clash stays beside the open form instead of vanishing as a pop-up.
    expect(document.querySelector('.ap-toasts')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText('New date and time')).toBeInTheDocument();
  });

  it('switches between the reschedule and cancel forms', () => {
    show(appointment());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Cancellation reason')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    expect(screen.queryByLabelText('Cancellation reason')).toBeNull();
    expect(screen.getByLabelText('New date and time')).toBeInTheDocument();
  });
});
