'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

type PrivacyRequest = { id: string; type: 'Export' | 'Deletion'; status: 'Pending' | 'Approved' | 'Denied' | 'Completed'; createdAtUtc: string; updatedAtUtc: string | null };
const date = (value: string) => new Date(value).toLocaleDateString();

export function CustomerPrivacyRequestForm({ token }: { token: string }) {
  const [requests, setRequests] = useState<PrivacyRequest[] | null>(null);
  const [type, setType] = useState<'Export' | 'Deletion'>('Export');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  
  async function load() {
    setError('');
    try { setRequests((await api<{ requests: PrivacyRequest[] }>('/api/customer-portal/privacy-requests/list', { method: 'POST', json: { token } })).requests); }
    catch (err) { setError(messageFor(err)); }
  }
  useEffect(() => { let alive = true; api<{ requests: PrivacyRequest[] }>('/api/customer-portal/privacy-requests/list', { method: 'POST', json: { token } }).then((result) => { if (alive) setRequests(result.requests); }).catch((err) => { if (alive) setError(messageFor(err)); }); return () => { alive = false; }; }, [token]);

  async function submit() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ request: PrivacyRequest; alreadyPending: boolean }>('/api/customer-portal/privacy-requests', { method: 'POST', json: { token, type, ...(note.trim() ? { note: note.trim() } : {}) } });
      toast.success(result.alreadyPending ? 'You already have an open request of this type.' : 'Your request has been submitted. The business will review it.');
      setNote(''); await load();
    } catch (err) { toast.error(messageFor(err)); }
    finally { setBusy(false); }
  }

  return <section className="ap-panel ap-stack" aria-labelledby="privacy-request-heading">
    <h2 className="ap-h2" id="privacy-request-heading">Your data and privacy</h2>
    <p className="ap-foot">You can request a copy of the customer information held by this business or ask it to delete your data. Some order or financial records may need to be retained.</p>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    <label className="ap-stack"><span>Request type</span><select className="ap-input" value={type} onChange={(event) => setType(event.target.value as 'Export' | 'Deletion')} disabled={busy}><option value="Export">Request a copy of my data</option><option value="Deletion">Request data deletion</option></select></label>
    <label className="ap-stack"><span>Optional note</span><textarea className="ap-input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} disabled={busy} placeholder="Add details for the business (optional)" /></label>
    <div><button className="ap-btn" type="button" disabled={busy} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit request'}</button></div>
    <h3 className="ap-h3">Your requests</h3>
    {requests === null && !error ? <p className="ap-foot" aria-live="polite">Loading your requests…</p> : requests === null ? <button className="ap-btn ap-btn-quiet" type="button" onClick={() => void load()}>Retry loading requests</button> : requests.length === 0 ? <p className="ap-hint">You have not submitted a data request.</p> : <ul className="ap-plain">{requests.map((request) => <li key={request.id}>{request.type === 'Export' ? 'Data export' : 'Data deletion'} — <strong>{request.status}</strong> · submitted {date(request.createdAtUtc)}</li>)}</ul>}
  </section>;
}
