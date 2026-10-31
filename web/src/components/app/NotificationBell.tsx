'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import {
  notificationQuery, notificationTargetHref, unreadBadge,
  type NotificationPage, type NotificationUnreadCount,
} from '@/lib/notifications-view-model';

type Props = { placement: 'desktop' | 'mobile' };

function BellIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </svg>
  );
}

const CATEGORY_ICONS: Record<string, string> = {
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  schedule: 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  orders: 'M5 4h14a1 1 0 011 1v15H4V5a1 1 0 011-1zM9 10h6M9 14h6',
  inquiries: 'M5 5h14a1 1 0 011 1v9a1 1 0 01-1 1H10l-4 3.5V16H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  finance: 'M4 7a2 2 0 012-2h12v4M4 7v11a2 2 0 002 2h14V9H6a2 2 0 01-2-2zM16 14.5h.01',
  inventory: 'M4 8l8-4 8 4v8l-8 4-8-4V8zM4 8l8 4 8-4M12 12v8',
  billing: 'M3 7h18v10H3zM3 11h18',
};

export function NotificationRow({ item, onRead, busy }: {
  item: NotificationPage['items'][number];
  onRead?: (id: string) => void;
  busy?: boolean;
}) {
  const href = notificationTargetHref(item);
  return (
    <article className={`ap-notification-row${item.isRead ? ' is-read' : ' is-unread'}`}>
      <span className="ap-notification-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d={CATEGORY_ICONS[item.category] ?? 'M6 17h12l-1.5-2V10a4.5 4.5 0 00-9 0v5L6 17zM10 20h4'} /></svg></span>
      <div className="ap-notification-copy">
        {href ? <Link href={href} className="ap-notification-title">{item.title}</Link> : <strong className="ap-notification-title">{item.title}</strong>}
        <p>{item.body}</p>
        <time dateTime={item.createdAtUtc}>{new Date(item.createdAtUtc).toLocaleString()}</time>
      </div>
      {!item.isRead && onRead && (
        <button className="ap-notification-read" type="button" disabled={busy} onClick={() => onRead(item.id)} aria-label={`Mark ${item.title} as read`} title="Mark as read">
          <span aria-hidden="true">✓</span>
        </button>
      )}
    </article>
  );
}

export function NotificationBell({ placement }: Props) {
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<NotificationUnreadCount>({ count: 0, capped: false });
  const [panel, setPanel] = useState<NotificationPage | null>(null);
  const [countError, setCountError] = useState('');
  const [panelError, setPanelError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [busyAll, setBusyAll] = useState(false);
  const [reload, setReload] = useState(0);
  const badge = unreadBadge(count.count, count.capped);
  const panelId = `ap-notifications-${placement}`;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 48rem)');
    const update = () => setVisible(placement === 'mobile' ? media.matches : !media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [placement]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const loadCount = async () => {
      try {
        const next = await api<NotificationUnreadCount>('/api/notifications/unread-count');
        if (!cancelled) { setCount(next); setCountError(''); }
      } catch (error) {
        if (!cancelled) setCountError(messageFor(error));
      }
    };
    void loadCount();
    const timer = window.setInterval(loadCount, 60_000);
    const onFocus = () => { if (document.visibilityState === 'visible') void loadCount(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [visible, reload]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPanelError('');
    api<NotificationPage>(notificationQuery({ limit: 10 }))
      .then((next) => { if (!cancelled) setPanel(next); })
      .catch((error) => { if (!cancelled) setPanelError(messageFor(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function markRead(id: string) {
    setBusyId(id);
    try {
      await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', json: {} });
      setPanel((current) => current ? { ...current, items: current.items.map((item) => item.id === id ? { ...item, isRead: true, readAtUtc: new Date().toISOString() } : item) } : current);
      try {
        setCount(await api<NotificationUnreadCount>('/api/notifications/unread-count'));
      } catch (error) { setCountError(messageFor(error)); }
    } catch (error) { toast.error(messageFor(error)); }
    finally { setBusyId(''); }
  }

  async function markAllRead() {
    setBusyAll(true);
    try {
      await api('/api/notifications/read-all', { method: 'POST', json: {} });
      setPanel((current) => current ? { ...current, items: current.items.map((item) => ({ ...item, isRead: true, readAtUtc: item.readAtUtc ?? new Date().toISOString() })) } : current);
      setCount({ count: 0, capped: false });
      toast.success('All notifications marked as read.');
    } catch (error) { toast.error(messageFor(error)); }
    finally { setBusyAll(false); }
  }

  if (!visible) return <span className={`ap-notification-anchor is-${placement}`} aria-hidden="true" />;

  return (
    <div className={`ap-notification-anchor is-${placement}`}>
      <button
        className="ap-notification-bell"
        type="button"
        aria-label={badge ? `Notifications, ${badge} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <BellIcon />
        {badge && <span className="ap-notification-count" aria-hidden="true">{badge}</span>}
      </button>
      {open && (
        <section className="ap-notification-popover" id={panelId} aria-label="Recent notifications" aria-busy={loading}>
          <div className="ap-notification-popover-head">
            <h2>Notifications</h2>
            <button type="button" className="ap-link" disabled={busyAll || count.count === 0} onClick={() => void markAllRead()}>Mark all read</button>
          </div>
          {panelError && <div className="ap-alert" role="alert"><p>{panelError}</p><button type="button" className="ap-link" onClick={() => setReload((value) => value + 1)}>Try again</button></div>}
          {countError && <p className="ap-notification-hint" role="status">Unread count could not refresh. <button type="button" className="ap-link" onClick={() => setReload((value) => value + 1)}>Try again</button></p>}
          {loading && <p className="ap-notification-hint" role="status">Loading notifications…</p>}
          {!loading && !panelError && panel?.items.length === 0 && <p className="ap-notification-hint">You’re all caught up.</p>}
          {!loading && panel?.items.length ? (
            <div className="ap-notification-list">
              {panel.items.map((item) => <NotificationRow key={item.id} item={item} onRead={(id) => void markRead(id)} busy={busyId === item.id} />)}
            </div>
          ) : null}
          <div className="ap-notification-popover-foot">
            <Link href="/notifications" onClick={() => setOpen(false)}>View all notifications</Link>
            <Link href="/settings/notifications" onClick={() => setOpen(false)}>Preferences</Link>
          </div>
        </section>
      )}
    </div>
  );
}