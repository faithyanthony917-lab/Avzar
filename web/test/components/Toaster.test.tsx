// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';
import { Toaster } from '@/components/app/Toaster';
import { toast, TOAST_LIFETIME_MS } from '@/lib/toast';

beforeEach(() => { vi.useFakeTimers(); });

describe('Toaster', () => {
  it('renders nothing until there is a message', () => {
    const { container } = render(<Toaster />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces a success politely and an error as an alert', () => {
    render(<Toaster />);
    act(() => { toast.success('Saved.'); toast.error('Could not save.'); });
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
  });

  it('removes a success toast by itself after its time', () => {
    render(<Toaster />);
    act(() => { toast.success('Saved.'); });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS.success - 1); });
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('keeps an error longer than a success', () => {
    render(<Toaster />);
    act(() => { toast.error('Could not save.'); });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS.success + 1); });
    expect(screen.getByText('Could not save.')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS.error); });
    expect(screen.queryByText('Could not save.')).toBeNull();
  });

  it('closes when the close button is pressed', () => {
    render(<Toaster />);
    act(() => { toast.error('Could not save.'); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByText('Could not save.')).toBeNull();
  });

  it('waits while the pointer is on the toast and then restarts its timer', () => {
    render(<Toaster />);
    act(() => { toast.success('Saved.'); });
    const card = screen.getByRole('status');
    fireEvent.mouseEnter(card);
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS.success * 3); });
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    fireEvent.mouseLeave(card);
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS.success); });
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('shows a message made before it mounted', () => {
    toast.success('Early.');
    render(<Toaster />);
    expect(screen.getByText('Early.')).toBeInTheDocument();
  });
});
