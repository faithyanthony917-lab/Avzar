// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../support/dom';
import type { Inquiry } from '@/lib/inquiries-view-model';
import { ApiError } from '@/lib/problem';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { InquiryActions, type InquiryFormData } from '@/components/app/InquiryActions';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;

function inquiry(over: Partial<Inquiry> = {}): Inquiry {
  return {
    id: 'inq/1', kind: 'Appointment', status: 'New', name: 'Jane Doe', email: 'jane@example.test', phone: null, message: 'I would like a fitting.',
    designId: null, designName: null, garmentType: null, budget: null, preferredDate: null, eventDate: null, convertedOrderId: null, appointmentId: null,
    internalNote: null, createdAtUtc: '2026-10-25T10:00:00.000Z', handledAtUtc: null, ...over,
  };
}
const FORM: InquiryFormData = {
  locations: [{ id: 'loc1', label: 'Lagos shop' }],
  staff: [{ id: 'mem1', label: 'Ada', isOwner: true, locationIds: [] }, { id: 'mem2', label: 'Tunde', isOwner: false, locationIds: ['loc1'] }],
  canAssignAllLocations: true, currentMembershipId: 'mem1',
};
const localIn = (days: number, time = '10:00') => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}`;

function show(item: Inquiry, props: { canManage?: boolean; canBook?: boolean; form?: InquiryFormData | null } = {}) {
  return render(<><InquiryActions inquiry={item} timeZone="UTC" canManage={props.canManage ?? true} canBook={props.canBook ?? true} form={props.form === undefined ? FORM : props.form} /><Toaster /></>);
}
const openSchedule = () => fireEvent.click(screen.getByRole('button', { name: 'Schedule appointment' }));

beforeEach(() => { apiMock.mockReset(); refresh.mockReset(); });

describe('which actions are offered', () => {
  it('offers all three on an open booking request', () => {
    show(inquiry());
    expect(screen.getByRole('button', { name: 'Schedule appointment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert to order' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update status or note' })).toBeInTheDocument();
  });
  it('does not offer scheduling for any other kind of request', () => {
    show(inquiry({ kind: 'Inquiry' }));
    expect(screen.queryByRole('button', { name: 'Schedule appointment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Convert to order' })).toBeInTheDocument();
  });
  it('does not offer scheduling without fittings.manage', () => {
    show(inquiry(), { canBook: false });
    expect(screen.queryByRole('button', { name: 'Schedule appointment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Convert to order' })).toBeInTheDocument();
  });
  it('offers nothing to someone who can only view', () => {
    const { container } = show(inquiry(), { canManage: false, canBook: false });
    expect(container).toBeEmptyDOMElement();
  });
  it('offers nothing once the request has an appointment', () => {
    const { container } = show(inquiry({ status: 'Converted', appointmentId: 'a1' }));
    expect(container).toBeEmptyDOMElement();
  });
  it('lets a rejected request be reopened but not scheduled or converted', () => {
    show(inquiry({ status: 'Rejected' }));
    expect(screen.queryByRole('button', { name: 'Schedule appointment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Convert to order' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Update status or note' })).toBeInTheDocument();
  });
});

describe('scheduling', () => {
  it('preselects the only location and the signed-in staff member, then posts the appointment and refreshes', async () => {
    apiMock.mockResolvedValue({ inquiry: inquiry({ status: 'Converted', appointmentId: 'a1' }), appointment: { id: 'a1', type: 'Fitting', startUtc: `${localIn(30)}:00.000Z`, endUtc: `${localIn(30, '10:30')}:00.000Z` } });
    show(inquiry());
    openSchedule();
    expect(screen.getByLabelText('Location')).toHaveValue('loc1');
    expect(screen.getByLabelText('Assigned staff')).toHaveValue('mem1');
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: localIn(30) } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Schedule appointment' }).at(-1)!);
    expect(await screen.findByRole('status')).toHaveTextContent('Fitting scheduled for');
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiMock.mock.calls[0] as [string, { method: string; json: Record<string, unknown> }];
    expect(path).toBe('/api/inquiries/inq/1/schedule');
    expect(init.method).toBe('POST');
    expect(init.json).toEqual({
      type: 'Fitting', locationId: 'loc1', assignedMembershipId: 'mem1', startAt: `${localIn(30)}:00.000Z`, endAt: `${localIn(30, '10:30')}:00.000Z`, notes: null,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('checks the form before calling the API', () => {
    show(inquiry());
    openSchedule();
    fireEvent.click(screen.getAllByRole('button', { name: 'Schedule appointment' }).at(-1)!);
    expect(screen.getByText('Enter the date and time.')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows which appointment the time clashes with and does not refresh', async () => {
    apiMock.mockRejectedValue(new ApiError(409, 'This time conflicts with another appointment.', 'appointment_conflict', {}, {
      conflicts: [{ type: 'Fitting', startUtc: `${localIn(30)}:00.000Z`, conflictOn: ['staff'] }],
    }));
    show(inquiry());
    openSchedule();
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: localIn(30) } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Schedule appointment' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent('(staff conflict)');
    // A clash stays beside the open form instead of vanishing as a pop-up.
    expect(document.querySelector('.ap-toasts')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes the list when the request turns out to be scheduled already', async () => {
    apiMock.mockRejectedValue(new ApiError(409, 'This request already has an appointment.', 'inquiry_already_scheduled'));
    show(inquiry());
    openSchedule();
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: localIn(30) } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Schedule appointment' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent('This request already has an appointment.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('only offers staff who work at the chosen location when the user cannot assign everywhere', () => {
    show(inquiry(), { form: { ...FORM, canAssignAllLocations: false, staff: [{ id: 'mem2', label: 'Tunde', isOwner: false, locationIds: ['loc9'] }] } });
    openSchedule();
    expect(screen.queryByRole('option', { name: 'Tunde' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Schedule appointment' }).at(-1)).toBeDisabled();
  });

  it('explains what is missing when the staff and location lists could not be loaded', () => {
    show(inquiry(), { form: null });
    openSchedule();
    expect(screen.getByText(/also needs permission to view staff and locations/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Date and time')).toBeNull();
  });

  it('disables the form while the request is in flight', async () => {
    const gate = deferred<unknown>();
    apiMock.mockReturnValue(gate.promise);
    show(inquiry());
    openSchedule();
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: localIn(30) } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Schedule appointment' }).at(-1)!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scheduling…' })).toBeDisabled());
    gate.resolve({ inquiry: inquiry(), appointment: { id: 'a1', type: 'Fitting', startUtc: `${localIn(30)}:00.000Z`, endUtc: `${localIn(30, '10:30')}:00.000Z` } });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});

describe('convert to order', () => {
  it('posts the order details and refreshes', async () => {
    apiMock.mockResolvedValue(inquiry({ status: 'Converted', convertedOrderId: 'o1' }));
    show(inquiry({ kind: 'OrderRequest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Convert to order' }));
    fireEvent.change(screen.getByLabelText('Promised date'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Order created from this request.');
    expect(apiMock).toHaveBeenCalledWith('/api/inquiries/inq/1/convert', { method: 'POST', json: { locationId: 'loc1', promisedDate: '2026-12-01', garmentName: null, unitPrice: 125.5 } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('checks the price before calling the API', () => {
    show(inquiry({ kind: 'OrderRequest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Convert to order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(screen.getByText('Enter the price as a number with at most two decimals.')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe('status and note', () => {
  it('saves the chosen status and a trimmed note', async () => {
    apiMock.mockResolvedValue(inquiry({ status: 'Rejected' }));
    show(inquiry());
    fireEvent.click(screen.getByRole('button', { name: 'Update status or note' }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Rejected' } });
    fireEvent.change(screen.getByLabelText('Internal note'), { target: { value: '  Spam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Request updated.');
    expect(apiMock).toHaveBeenCalledWith('/api/inquiries/inq/1', { method: 'PUT', json: { status: 'Rejected', internalNote: 'Spam' } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('shows the server error and keeps the form open', async () => {
    apiMock.mockRejectedValue(new ApiError(409, 'This request was already handled and cannot be changed.', 'already_converted'));
    show(inquiry());
    fireEvent.click(screen.getByRole('button', { name: 'Update status or note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already handled');
    expect(screen.getByLabelText('Internal note')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
