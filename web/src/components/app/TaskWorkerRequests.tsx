'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import { plannedActualDifference } from '@/lib/production-workflows';
import { Pager, usePaged } from './Pager';
import { toast } from '@/lib/toast';

type WorkerRequest = {
  id: string; taskId: string; type: 'Assistance' | 'Reassignment' | 'Discrepancy'; status: 'Pending' | 'Accepted' | 'Declined';
  message: string; plannedMinutes: number | null; actualMinutes: number | null; createdAtUtc: string;
  reviewNote: string | null; reviewedAtUtc: string | null; taskTitle: string; taskStatus: string;
  orderNumber: string; requestedByName: string;
};
const labels: Record<WorkerRequest['type'], string> = { Assistance: 'Request assistance', Reassignment: 'Request reassignment', Discrepancy: 'Planned vs actual time' };

export function TaskWorkerRequests({ initial }: { initial: WorkerRequest[] }) {
  const [items, setItems] = useState(initial);
  const paged = usePaged(items);
  const [filter, setFilter] = useState('Pending');
  const [busyId, setBusyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  async function reload(next: string) {
    setFilter(next); setError(''); setLoading(true);
    try { setItems(await api<WorkerRequest[]>(`/api/tasks/worker-requests?status=${encodeURIComponent(next === 'all' ? 'all' : next)}`)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load worker requests.'); }
    finally { setLoading(false); }
  }
  async function review(item: WorkerRequest, status: 'Accepted' | 'Declined') {
    setBusyId(item.id); setError('');
    try {
      await api(`/api/tasks/worker-requests/${item.id}/review`, { method: 'POST', json: { status, note: notes[item.id]?.trim() || null } });
      await reload(filter);
      toast.success(`Request ${status.toLowerCase()}.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not review request.'); }
    finally { setBusyId(''); }
  }
  return <section className="ap-panel ap-stack" aria-labelledby="worker-requests-title">
    <div className="ap-row"><h2 id="worker-requests-title" className="ap-h2">Worker requests</h2><label className="ap-field"><span>Filter</span><select className="ap-input" value={filter} onChange={(e) => void reload(e.target.value)}><option value="Pending">Pending</option><option value="Accepted">Accepted</option><option value="Declined">Declined</option><option value="all">All requests</option></select></label></div>
    {error && <p className="ap-alert" role="alert">{error}</p>}{loading && <p className="ap-foot" role="status">Loading worker requests…</p>}
    {items.length === 0 ? <p>No {filter === 'all' ? '' : filter.toLowerCase() + ' '}worker requests.</p> : paged.slice.map((item) => <article className="ap-panel ap-stack" key={item.id}>
      <div className="ap-row"><div><h3 className="ap-h3">{labels[item.type]}</h3><p className="ap-foot">{item.requestedByName} · Order {item.orderNumber} · {item.taskTitle}</p></div><span className="ap-badge">{item.status}</span></div>
      <p>{item.message}</p>
      {item.type === 'Discrepancy' && <p className="ap-small">Planned: {item.plannedMinutes} minutes · Actual: {item.actualMinutes} minutes · Difference: {plannedActualDifference(Number(item.plannedMinutes), Number(item.actualMinutes))} minutes</p>}
      <p className="ap-small ap-dim">Submitted {new Date(item.createdAtUtc).toISOString()}</p>
      {item.status === 'Pending' ? <><div className="ap-field"><label htmlFor={`review-note-${item.id}`}>Review note (optional)</label><textarea id={`review-note-${item.id}`} className="ap-input" maxLength={1000} rows={2} value={notes[item.id] ?? ''} onChange={(e) => setNotes((old) => ({ ...old, [item.id]: e.target.value }))} /></div><div className="ap-actions"><button type="button" className="ap-btn" disabled={!!busyId} onClick={() => void review(item, 'Accepted')}>{busyId === item.id ? 'Saving…' : 'Accept request'}</button><button type="button" className="ap-btn ap-btn-quiet" disabled={!!busyId} onClick={() => void review(item, 'Declined')}>Decline</button></div></> : item.reviewNote && <p className="ap-small">Review note: {item.reviewNote}</p>}
    </article>)}
    <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Worker requests pages" />
    {busyId && <p className="ap-foot" role="status">Saving review…</p>}
  </section>;
}
