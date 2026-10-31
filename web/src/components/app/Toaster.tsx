'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getServerToasts, getToasts, subscribeToasts, toast, TOAST_LIFETIME_MS, type ToastItem } from '@/lib/toast';

function ToastCard({ item }: { item: ToastItem }) {
  // The timer stops while the pointer or keyboard focus is on the toast, so a message can always be read to the end.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => toast.dismiss(item.id), TOAST_LIFETIME_MS[item.kind]);
    return () => window.clearTimeout(timer);
  }, [item.id, item.kind, paused]);

  const isError = item.kind === 'error';
  return (
    <div
      className={`ap-toast ${isError ? 'is-error' : 'is-success'}`}
      role={isError ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <svg className="ap-toast-icon" aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {isError ? <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></> : <path d="M20 6 9 17l-5-5" />}
      </svg>
      <p className="ap-toast-text">{item.text}</p>
      <button type="button" className="ap-toast-close" aria-label="Dismiss message" onClick={() => toast.dismiss(item.id)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

/** Shows the pop-up messages. Mounted once in the signed-in app layout. */
export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  if (items.length === 0) return null;
  return <div className="ap-toasts">{items.map((item) => <ToastCard key={item.id} item={item} />)}</div>;
}
