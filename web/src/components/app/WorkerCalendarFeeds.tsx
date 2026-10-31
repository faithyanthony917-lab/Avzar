'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

type Feed = { id: string; createdAtUtc: string; lastUsedAtUtc: string | null; revokedAtUtc: string | null; expiresAtUtc: string | null };
type Created = { id: string; urlPath: string; token: string };
const when = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/** Calendar link for one worker. The link is shown once, when it is made; afterwards only its dates are listed. */
export function WorkerCalendarFeeds({ membershipId, workerName }: { membershipId: string; workerName: string }) {
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // Only a failed load stays on the page (there is nothing else to show); the result of an action is a pop-up.
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try { setFeeds(await api<Feed[]>(`/api/workers/${membershipId}/schedule/calendar-feeds`)); }
    catch (e) { setFeeds([]); setLoadError(messageFor(e)); }
  }, [membershipId]);

  // A link belongs to one worker: never keep showing it after the manager switches to another.
  useEffect(() => { setFeeds(null); setLink(''); setCopied(false); void load(); }, [load]);

  async function create() {
    setBusy(true); setCopied(false);
    try {
      const made = await api<Created>(`/api/workers/${membershipId}/schedule/calendar-feed`, { method: 'POST' });
      // The calendar app reads the link through this site's address, the same way the browser reaches the API.
      setLink(`${window.location.origin}/backend${made.urlPath}`);
      toast.success('Calendar link made.');
      await load();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await api(`/api/workers/${membershipId}/schedule/calendar-feed/${id}`, { method: 'DELETE' });
      setLink(''); toast.success('Calendar link stopped. Calendars that use it will no longer update.');
      await load();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); toast.success('Link copied.'); }
    catch { toast.error('Could not copy automatically. Select the link and copy it by hand.'); }
  }

  const active = (feeds ?? []).filter((f) => !f.revokedAtUtc);
  const old = (feeds ?? []).filter((f) => f.revokedAtUtc);
  return <section className="ap-panel ap-stack" aria-labelledby="calendar-feed-title">
    <h2 className="ap-h2" id="calendar-feed-title">Calendar link for {workerName}</h2>
    <p className="ap-foot" style={{ margin: 0 }}>Add this worker&apos;s planned tasks and fittings to a phone or computer calendar. Anyone who has the link can see the schedule, so share it only with this worker. Appointment notes are never included.</p>
    {loadError && <p className="ap-alert" role="alert">{loadError}</p>}
    {link && <div className="ap-stack" role="status">
      <p style={{ margin: 0 }}><strong>Copy this link now.</strong> It is shown only once; if you lose it, stop it and make a new one.</p>
      <div className="ap-actions">
        <input className="ap-input" readOnly value={link} aria-label="Calendar link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="ap-btn ap-btn-quiet" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
    </div>}
    {feeds === null ? <p className="ap-foot" style={{ margin: 0 }}>Loading calendar links…</p>
      : active.length === 0 ? <p className="ap-foot" style={{ margin: 0 }}>No active calendar link.</p>
        : <ul className="ap-stack" style={{ margin: 0, paddingLeft: '1.1rem' }}>{active.map((f) => <li key={f.id}>
          Made {when(f.createdAtUtc)}; {f.lastUsedAtUtc ? `last used ${when(f.lastUsedAtUtc)}` : 'not used yet'}.{' '}
          <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={() => void revoke(f.id)}>Stop this link</button>
        </li>)}</ul>}
    {old.length > 0 && <p className="ap-foot" style={{ margin: 0 }}>{old.length} earlier {old.length === 1 ? 'link was' : 'links were'} stopped.</p>}
    <div><button type="button" className="ap-btn" disabled={busy || feeds === null} onClick={() => void create()}>Make a calendar link</button></div>
  </section>;
}
