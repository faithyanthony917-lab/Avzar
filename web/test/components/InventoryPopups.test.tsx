// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { ReadyToWearInventory } from '@/components/app/ReadyToWearInventory';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => { apiMock.mockReset(); refresh.mockReset(); });

const designs = [{ id: 'd1', name: 'Ankara shirt', basePrice: 100, currencyCode: 'NGN', visibility: 'Public' }];
const show = () => render(<><ReadyToWearInventory designs={designs} variants={[]} /><Toaster /></>);

describe('ready-to-wear stock: results of an action are pop-ups', () => {
  it('confirms an added stock variant with a success pop-up', async () => {
    apiMock.mockResolvedValue({});
    show();
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'ANK-M' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add stock variant' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Stock variant added.');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('shows a refused save as an error pop-up', async () => {
    apiMock.mockRejectedValue(new ApiError(409, 'That SKU already exists.'));
    show();
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'ANK-M' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add stock variant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That SKU already exists.');
  });

  it('keeps a check on what the person typed on the page, not in a pop-up', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add stock variant' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a product, enter a SKU');
    expect(document.querySelector('.ap-toasts')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
