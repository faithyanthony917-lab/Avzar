// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/client', () => ({ api: vi.fn() }));

import { api } from '@/lib/client';
import { ApiError } from '@/lib/problem';
import { LocationManager } from '@/components/app/LocationManager';
import { Toaster } from '@/components/app/Toaster';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => { apiMock.mockReset(); refresh.mockReset(); });

describe('failed actions are error pop-ups', () => {
  it('shows a refused location save as an error pop-up', async () => {
    apiMock.mockRejectedValue(new ApiError(403, 'Your plan allows 1 location.'));
    render(<><LocationManager locations={[]} canManage /><Toaster /></>);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Surulere' } });
    fireEvent.click(screen.getByRole('button', { name: /add location/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your plan allows 1 location.');
  });
});
