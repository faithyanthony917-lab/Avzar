// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn(), apiUpload: vi.fn() }));

import { api, apiUpload } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { OrderReferenceImages, TaskReferenceImages } from '@/components/app/OrderReferenceImages';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const uploadMock = vi.mocked(apiUpload) as unknown as ReturnType<typeof vi.fn>;
const successFn = vi.fn();
const errorFn = vi.fn();

const image = (id: string, caption: string | null) => ({ id, orderId: 'order-1', mediaId: `media-${id}`, caption, fileName: `${id}.png`, width: 40, height: 30, sizeBytes: 900, createdAtUtc: '2026-11-02T10:00:00Z' });

// Braces matter: a beforeEach that returns the mock would be run again as a clean-up function.
beforeEach(() => {
  vi.restoreAllMocks();
  apiMock.mockReset();
  uploadMock.mockReset();
  // The shared DOM setup clears the real toast after each test, so the real object is spied on, not replaced.
  successFn.mockReset();
  errorFn.mockReset();
  vi.spyOn(toast, 'success').mockImplementation(successFn);
  vi.spyOn(toast, 'error').mockImplementation(errorFn);
});

describe('OrderReferenceImages', () => {
  it('lists the images with their captions and the count', async () => {
    apiMock.mockResolvedValue({ items: [image('a', 'Neckline'), image('b', null)], maxImages: 10 });
    render(<OrderReferenceImages orderId="order-1" canManage />);
    expect(await screen.findByAltText('Neckline')).toBeTruthy();
    expect(screen.getByAltText('Reference image b.png')).toBeTruthy();
    expect(screen.getByText(/2 of 10 images/)).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/api/orders/order-1/reference-images');
    expect(screen.getByAltText('Neckline').getAttribute('src')).toBe('/backend/api/orders/order-1/reference-images/a/file/md');
  });

  it('says so when there are no images', async () => {
    apiMock.mockResolvedValue({ items: [], maxImages: 10 });
    render(<OrderReferenceImages orderId="order-1" canManage />);
    expect(await screen.findByText('No reference images yet.')).toBeTruthy();
  });

  it('shows no upload or remove controls without orders.manage, or on a cancelled order', async () => {
    apiMock.mockResolvedValue({ items: [image('a', 'Neckline')], maxImages: 10 });
    const first = render(<OrderReferenceImages orderId="order-1" canManage={false} />);
    await screen.findByAltText('Neckline');
    expect(screen.queryByRole('button', { name: 'Add image' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    first.unmount();
    render(<OrderReferenceImages orderId="order-1" canManage orderCancelled />);
    await screen.findByAltText('Neckline');
    expect(screen.queryByRole('button', { name: 'Add image' })).toBeNull();
  });

  it('uploads the chosen file with its caption and reloads the list', async () => {
    apiMock.mockResolvedValueOnce({ items: [], maxImages: 10 }).mockResolvedValueOnce({ items: [image('a', 'Front')], maxImages: 10 });
    uploadMock.mockResolvedValue(image('a', 'Front'));
    render(<OrderReferenceImages orderId="order-1" canManage />);
    await screen.findByText('No reference images yet.');
    const file = new File(['x'], 'front.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose image'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Caption (optional)'), { target: { value: ' Front ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith('/api/orders/order-1/reference-images', file, { caption: 'Front' }));
    expect(await screen.findByAltText('Front')).toBeTruthy();
    expect(successFn).toHaveBeenCalledWith('Reference image added.');
  });

  it('refuses a file that is not an image without calling the API', async () => {
    apiMock.mockResolvedValue({ items: [], maxImages: 10 });
    render(<OrderReferenceImages orderId="order-1" canManage />);
    await screen.findByText('No reference images yet.');
    fireEvent.change(screen.getByLabelText('Choose image'), { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/choose an image file/i);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('shows the refusal from the server as a message and keeps the list', async () => {
    apiMock.mockResolvedValue({ items: [image('a', 'Neckline')], maxImages: 10 });
    uploadMock.mockImplementation(() => Promise.reject(new ApiError(409, 'An order can have at most 10 reference images. Remove one first.', 'reference_image_limit')));
    render(<OrderReferenceImages orderId="order-1" canManage />);
    await screen.findByAltText('Neckline');
    fireEvent.change(screen.getByLabelText('Choose image'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    await waitFor(() => expect(errorFn).toHaveBeenCalledWith('An order can have at most 10 reference images. Remove one first.'));
    expect(screen.getByAltText('Neckline')).toBeTruthy();
  });

  it('disables adding when the limit is reached', async () => {
    apiMock.mockResolvedValue({ items: [image('a', null), image('b', null)], maxImages: 2 });
    render(<OrderReferenceImages orderId="order-1" canManage />);
    await screen.findByAltText('Reference image a.png');
    expect(screen.getByRole('button', { name: 'Add image' })).toBeDisabled();
  });

  it('removes an image only after confirmation', async () => {
    apiMock.mockResolvedValueOnce({ items: [image('a', 'Neckline')], maxImages: 10 }).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ items: [], maxImages: 10 });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<OrderReferenceImages orderId="order-1" canManage />);
    await screen.findByAltText('Neckline');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Neckline' }));
    expect(apiMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Neckline' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/orders/order-1/reference-images/a', { method: 'DELETE' }));
    expect(await screen.findByText('No reference images yet.')).toBeTruthy();
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it('shows an error when the list cannot be loaded', async () => {
    apiMock.mockImplementation(() => Promise.reject(new ApiError(404, 'Order not found.', 'order_not_found')));
    render(<OrderReferenceImages orderId="order-1" canManage />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/order not found/i);
  });
});

describe('TaskReferenceImages', () => {
  it('shows the images of the order behind the task, read-only', async () => {
    apiMock.mockResolvedValue({ items: [image('a', 'Neckline')] });
    render(<TaskReferenceImages taskId="task-1" />);
    const img = await screen.findByAltText('Neckline');
    expect(apiMock).toHaveBeenCalledWith('/api/my/tasks/task-1/reference-images');
    expect(img.getAttribute('src')).toBe('/backend/api/my/tasks/task-1/reference-images/a/file/md');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when there are no images', async () => {
    apiMock.mockResolvedValue({ items: [] });
    const { container } = render(<TaskReferenceImages taskId="task-1" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
