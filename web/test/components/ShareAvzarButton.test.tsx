// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from '@/lib/toast';
import { ShareAvzarButton } from '@/components/app/ShareAvzarButton';

const nav = navigator as unknown as Record<string, unknown>;

function setNavigator(share: unknown, writeText: unknown) {
  Object.defineProperty(nav, 'share', { value: share, configurable: true });
  Object.defineProperty(nav, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true });
}

describe('ShareAvzarButton', () => {
  beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear(); });
  afterEach(() => { cleanup(); setNavigator(undefined, undefined); });

  it('opens the share sheet with the site address when the device has one', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator(share, undefined);
    render(<ShareAvzarButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Share Avzar' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: window.location.origin })));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says nothing when the share sheet is closed without sharing', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError'));
    const writeText = vi.fn();
    setNavigator(share, writeText);
    render(<ShareAvzarButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Share Avzar' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('copies the link when there is no share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator(undefined, writeText);
    render(<ShareAvzarButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Share Avzar' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.origin));
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows the link when copying is blocked too', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setNavigator(undefined, writeText);
    render(<ShareAvzarButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Share Avzar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(window.location.origin)));
  });
});
