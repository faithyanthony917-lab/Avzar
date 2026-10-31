'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

type RequestType = 'Export' | 'Deletion';
type RequestStatus = 'Pending' | 'Approved' | 'Denied' | 'Completed';
type PrivacyRequest = {
  id: string; type: RequestType; status: RequestStatus; customerNote: string | null; staffNote: string | null;
  createdAtUtc: string; updatedAtUtc: string | null; reviewedAtUtc: string | null; reviewedByUserId: string | null;
};

const date = (value: string) => new Date(value).toLocaleString();

export function CustomerPrivacyRequests({ customerId }: { customerId: string }) {
  const [requests, setRequests] = useState<PrivacyRequest[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [staffNote, setStaffNote] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try { setRequests(await api<PrivacyRequest[]>(`/api/customers/${customerId}/privacy-requests`)); }
    catch (err) { setError(messageFor(err)); }
  }

  useEffect(() => { let alive = true; api<PrivacyRequest[]>(`/api/customers/${customerId}/privacy-requests`).then((value) => { if (alive) setRequests(value); }).catch((err) => { if (alive) setError(messageFor(err)); }); return () => { alive = false; }; }, [customerId]);

  async function review(request: PrivacyRequest, status: 'Approved' | 'Denied' | 'Completed') {
    if (busyId) return;
    setBusyId(request.id);
    try {
      await api(`/api/customers/${customerId}/privacy-requests/${request.id}/review`, { method: 'POST', json: { status, ...(staffNote.trim() ? { staffNote: staffNote.trim() } : {}) } });
      toast.success(`Request ${status.toLowerCase()}.`); setStaffNote(''); await load();
    } catch (err) { toast.error(messageFor(err)); }
    finally { setBusyId(null); }
  }

  return <section className="ap-panel ap-stack" aria-labelledby="privacy-requests-heading">
    <h2 id="privacy-requests-heading" className="ap-h2">Customer data requests</h2>
    <p className="ap-foot">Review requests to export or delete customer data. After approval, carry out the appropriate export or deletion before marking the request completed. Avzar does not automatically send exports or erase records that may need to be retained for legal or financial reasons.</p>
    {error && <p role="alert" className="ap-alert">{error}</p>}
    {requests?.some((request) => request.status === 'Pending' || request.status === 'Approved') && <label className="ap-stack"><span>Staff note (optional)</span><textarea className="ap-input" value={staffNote} onChange={(event) => setStaffNote(event.target.value)} maxLength={500} rows={2} disabled={busyId !== null} placeholder="Explain the decision or completion (optional)" /></label>}
    {requests === null && !error ? <p className="ap-foot" aria-live="polite">Loading data requests…</p> : requests === null ? <button className="ap-btn ap-btn-quiet" type="button" onClick={() => void load()}>Retry loading requests</button> : requests.length === 0 ? <p className="ap-hint">No data requests from this customer.</p> : requests.map((request) => <article className="ap-panel ap-stack" key={request.id}>
      <div className="ap-row"><strong>{request.type === 'Deletion' ? 'Deletion request' : 'Data export request'}</strong><span className="ap-badge">{request.status}</span></div>
      <p className="ap-foot">Submitted {date(request.createdAtUtc)}</p>
      {request.customerNote && <p className="ap-pre">Customer note: {request.customerNote}</p>}
      {request.staffNote && <p className="ap-pre">Staff note: {request.staffNote}</p>}
      {request.status === 'Pending' && <div className="ap-actions">
        <button className="ap-btn" disabled={busyId !== null} onClick={() => void review(request, 'Approved')}>{busyId === request.id ? 'Saving…' : 'Approve'}</button>
        <button className="ap-btn ap-btn-quiet" disabled={busyId !== null} onClick={() => void review(request, 'Denied')}>Deny</button>
      </div>}
      {request.status === 'Approved' && <button className="ap-btn" disabled={busyId !== null} onClick={() => void review(request, 'Completed')}>{busyId === request.id ? 'Saving…' : 'Mark completed'}</button>}
    </article>)}
  </section>;
}
