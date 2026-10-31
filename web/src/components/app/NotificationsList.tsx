'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { notificationQuery, NOTIFICATION_CATEGORIES, type NotificationCategory, type NotificationItem, type NotificationPage } from '@/lib/notifications-view-model';
import { NotificationRow } from './NotificationBell';

export function NotificationsList() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [category, setCategory] = useState<NotificationCategory | ''>('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [busyAll, setBusyAll] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api<NotificationPage>(notificationQuery({ unread, category, limit: 20 }))
      .then((page) => {
        if (!cancelled) { setItems(page.items); setNextCursor(page.nextCursor); }
      })
      .catch((failure) => { if (!cancelled) setError(messageFor(failure)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [unread, category, reload]);

  async function markRead(id: string) {
    setBusyId(id);
    try {
      const saved = await api<NotificationItem>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', json: {} });
      setItems((current) => current.map((item) => item.id === id ? saved : item));
      toast.success('Notification marked as read.');
    } catch (failure) { toast.error(messageFor(failure)); }
    finally { setBusyId(''); }
  }

  async function markAllRead() {
    setBusyAll(true);
    try {
      await api('/api/notifications/read-all', { method: 'POST', json: category ? { category } : {} });
      toast.success('Notifications marked as read.');
      setReload((value) => value + 1);
    } catch (failure) { toast.error(messageFor(failure)); }
    finally { setBusyAll(false); }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await api<NotificationPage>(notificationQuery({ unread, category, limit: 20, cursor: nextCursor }));
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (failure) { setError(messageFor(failure)); }
    finally { setLoadingMore(false); }
  }

  return (
    <section className="ap-stack" aria-busy={loading || loadingMore}>
      <div className="ap-notification-controls">
        <div className="ap-notification-segment" aria-label="Notification read status">
          <button type="button" aria-pressed={!unread} onClick={() => setUnread(false)}>All</button>
          <button type="button" aria-pressed={unread} onClick={() => setUnread(true)}>Unread</button>
        </div>
        <label className="ap-notification-category">
          <span>Category</span>
          <select className="ap-input" value={category} onChange={(event) => setCategory(event.currentTarget.value as NotificationCategory | '')}>
            <option value="">All categories</option>
            {NOTIFICATION_CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <button className="ap-btn ap-btn-quiet ap-btn-sm" type="button" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} disabled={busyAll || loading || items.every((item) => item.isRead)} onClick={() => void markAllRead()}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          {busyAll ? 'Marking…' : 'Mark all read'}
        </button>
      </div>

      {error && <div className="ap-alert" role="alert"><p>{error}</p><button type="button" className="ap-link" onClick={() => setReload((value) => value + 1)}>Try again</button></div>}
      {loading && <p className="ap-foot" role="status">Loading notifications…</p>}
      {!loading && !error && items.length === 0 && (
        <p className="ap-notification-empty">{unread ? 'There are no unread notifications.' : 'No notifications yet.'}</p>
      )}
      {!loading && items.length > 0 && (
        <div className="ap-notification-page-list ap-panel">
          {items.map((item) => <NotificationRow key={item.id} item={item} onRead={(id) => void markRead(id)} busy={busyId === item.id} />)}
        </div>
      )}
      {nextCursor && <div className="ap-notification-more"><button className="ap-btn ap-btn-quiet" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
    </section>
  );
}