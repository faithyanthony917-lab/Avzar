'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import {
  minutesFromTime, NOTIFICATION_CATEGORIES, timeFromMinutes,
  type NotificationCategory, type NotificationPreferences,
} from '@/lib/notifications-view-model';

export function NotificationPreferencesEditor() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api<NotificationPreferences>('/api/notifications/preferences')
      .then((result) => { if (!cancelled) setPreferences(result); })
      .catch((failure) => { if (!cancelled) setError(messageFor(failure)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reload]);

  function setChannel(category: NotificationCategory, channel: 'inApp' | 'email' | 'push', enabled: boolean) {
    setPreferences((current) => current ? {
      ...current,
      categories: current.categories.map((entry) => entry.category === category ? { ...entry, [channel]: enabled } : entry),
    } : current);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preferences || saving) return;
    setSaving(true);
    try {
      const saved = await api<NotificationPreferences>('/api/notifications/preferences', {
        method: 'PUT',
        json: { categories: preferences.categories, quietHours: preferences.quietHours },
      });
      setPreferences(saved);
      toast.success('Notification preferences saved.');
    } catch (failure) { toast.error(messageFor(failure)); }
    finally { setSaving(false); }
  }

  if (loading && !preferences) return <p className="ap-foot" role="status">Loading preferences…</p>;
  if (error && !preferences) {
    return <div className="ap-stack"><p className="ap-alert" role="alert">{error}</p><button className="ap-btn" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button></div>;
  }
  if (!preferences) return null;

  return (
    <form className="ap-stack" onSubmit={save} aria-busy={saving}>
      <p className="ap-foot">In-app alerts are shown in the bell and notification list. Email is sent only for categories you enable. Quiet hours use your business time zone.</p>

      <section className="ap-panel ap-stack">
        <div>
          <h2 className="ap-h2">Notification channels</h2>
          <p className="ap-foot">Choose where each category can reach you.</p>
        </div>
        <div className="ap-scroll">
          <table className="ap-table ap-notification-preferences-table">
            <thead><tr><th scope="col">Category</th><th scope="col">In app</th><th scope="col">Email</th><th scope="col">Push</th></tr></thead>
            <tbody>
              {NOTIFICATION_CATEGORIES.map((entry) => {
                const preference = preferences.categories.find((item) => item.category === entry.id);
                if (!preference) return null;
                return (
                  <tr key={entry.id}>
                    <th scope="row">{entry.label}</th>
                    <td><label className="ap-notification-toggle"><span className="ap-sr">{entry.label} in-app notifications</span><input type="checkbox" checked={preference.inApp} onChange={(event) => setChannel(entry.id, 'inApp', event.currentTarget.checked)} /></label></td>
                    <td><label className="ap-notification-toggle"><span className="ap-sr">{entry.label} email notifications</span><input type="checkbox" checked={preference.email} onChange={(event) => setChannel(entry.id, 'email', event.currentTarget.checked)} /></label></td>
                    <td><label className="ap-notification-toggle"><span className="ap-sr">{entry.label} push notifications</span><input type="checkbox" checked={preference.push} disabled={!preferences.pushAvailable} onChange={(event) => setChannel(entry.id, 'push', event.currentTarget.checked)} /></label></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ap-panel ap-stack">
        <div>
          <h2 className="ap-h2">Quiet hours</h2>
          <p className="ap-foot">In-app notifications still appear. Quiet hours delay email and push delivery.</p>
        </div>
        <label className="ap-check">
          <input type="checkbox" checked={preferences.quietHours.enabled} onChange={(event) => setPreferences((current) => current ? {
            ...current, quietHours: { ...current.quietHours, enabled: event.currentTarget.checked },
          } : current)} />
          <span>Enable quiet hours</span>
        </label>
        <div className="ap-notification-time-fields">
          <label className="ap-field"><span>Start</span><input className="ap-input" type="time" value={timeFromMinutes(preferences.quietHours.startMinute)} disabled={!preferences.quietHours.enabled} onChange={(event) => {
            const minute = minutesFromTime(event.currentTarget.value);
            if (minute !== null) setPreferences((current) => current ? { ...current, quietHours: { ...current.quietHours, startMinute: minute } } : current);
          }} /></label>
          <label className="ap-field"><span>End</span><input className="ap-input" type="time" value={timeFromMinutes(preferences.quietHours.endMinute)} disabled={!preferences.quietHours.enabled} onChange={(event) => {
            const minute = minutesFromTime(event.currentTarget.value);
            if (minute !== null) setPreferences((current) => current ? { ...current, quietHours: { ...current.quietHours, endMinute: minute } } : current);
          }} /></label>
        </div>
      </section>

      {!preferences.pushAvailable && <p className="ap-foot" role="status">Push delivery is unavailable because the server has no Expo push credentials configured.</p>}
      {preferences.pushAvailable && <p className="ap-foot">Push is sent only to devices registered for your active session. Device registration will be available in the mobile app in a later step.</p>}
      <div className="ap-actions"><button className="ap-btn" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save preferences'}</button></div>
    </form>
  );
}