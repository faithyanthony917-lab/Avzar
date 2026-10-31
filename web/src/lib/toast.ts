// Small store behind the pop-up messages (toasts). Any screen calls toast.success(...) or toast.error(...);
// the <Toaster /> in the app layout shows them. No React context is needed, so a component can call it anywhere.

export type ToastKind = 'success' | 'error';
export type ToastItem = { id: number; kind: ToastKind; text: string };

/** At most this many toasts are on screen at once; the oldest goes first. */
export const MAX_TOASTS = 3;
/** How long a toast stays, in milliseconds. Errors stay longer because they usually need reading and acting on. */
export const TOAST_LIFETIME_MS: Record<ToastKind, number> = { success: 4000, error: 8000 };

const NONE: ToastItem[] = [];
let items: ToastItem[] = NONE;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() { for (const listener of listeners) listener(); }

function push(kind: ToastKind, text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  // The same message again replaces the one on screen, so the timer restarts instead of the stack filling with copies.
  const rest = items.filter((item) => !(item.kind === kind && item.text === clean));
  const id = nextId++;
  items = [...rest, { id, kind, text: clean }].slice(-MAX_TOASTS);
  emit();
  return id;
}

export const toast = {
  success: (text: string) => push('success', text),
  error: (text: string) => push('error', text),
  dismiss(id: number) {
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return;
    items = next.length ? next : NONE;
    emit();
  },
  /** Remove every toast. Used by tests so one test's messages never leak into the next. */
  clear() {
    if (items === NONE) return;
    items = NONE;
    emit();
  },
};

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getToasts(): ToastItem[] { return items; }
export function getServerToasts(): ToastItem[] { return NONE; }
