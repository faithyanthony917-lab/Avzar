import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToasts, MAX_TOASTS, subscribeToasts, toast, TOAST_LIFETIME_MS } from '@/lib/toast';

beforeEach(() => { toast.clear(); });
afterEach(() => { toast.clear(); vi.useRealTimers(); });

describe('toast store', () => {
  it('adds a success and an error toast in order', () => {
    toast.success('Saved.');
    toast.error('Could not save.');
    expect(getToasts().map((t) => [t.kind, t.text])).toEqual([['success', 'Saved.'], ['error', 'Could not save.']]);
  });

  it('ignores empty text and trims the rest', () => {
    expect(toast.success('   ')).toBe(0);
    toast.success('  Saved.  ');
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]?.text).toBe('Saved.');
  });

  it('replaces a repeated message instead of stacking copies', () => {
    const first = toast.error('Offline.');
    const second = toast.error('Offline.');
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]?.id).toBe(second);
    expect(second).not.toBe(first);
  });

  it('shows the same words as success and as error separately', () => {
    toast.success('Done.');
    toast.error('Done.');
    expect(getToasts()).toHaveLength(2);
  });

  it('keeps at most the newest few toasts', () => {
    for (let i = 0; i < MAX_TOASTS + 2; i += 1) toast.success(`Message ${i}`);
    const texts = getToasts().map((t) => t.text);
    expect(texts).toHaveLength(MAX_TOASTS);
    expect(texts[texts.length - 1]).toBe(`Message ${MAX_TOASTS + 1}`);
    expect(texts).not.toContain('Message 0');
  });

  it('dismisses one toast and tells subscribers', () => {
    const listener = vi.fn();
    const stop = subscribeToasts(listener);
    const id = toast.success('A');
    toast.success('B');
    listener.mockClear();
    toast.dismiss(id);
    expect(getToasts().map((t) => t.text)).toEqual(['B']);
    expect(listener).toHaveBeenCalledTimes(1);
    toast.dismiss(id); // already gone: no notification
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    toast.success('C');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('lets errors stay longer than successes', () => {
    expect(TOAST_LIFETIME_MS.error).toBeGreaterThan(TOAST_LIFETIME_MS.success);
  });
});
