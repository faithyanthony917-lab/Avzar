'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import type { CustomerSummary, Paged } from '@/lib/customer-types';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

/** Merges THIS profile (the source) into another one the person picks. The source is kept but marked Merged. */
export function MergePanel({ sourceId, sourceName }: { sourceId: string; sourceName: string }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerSummary[] | null>(null);
  const [pick, setPick] = useState<CustomerSummary | null>(null);
  const [busy, setBusy] = useState(false);
  
  async function search(e: FormEvent) {
    e.preventDefault();
    if (busy || q.trim().length < 2) return;
    setBusy(true); setPick(null);
    try {
      const page = await api<Paged<CustomerSummary>>(`/api/customers?${new URLSearchParams({ search: q.trim(), status: 'Active', pageSize: '8' })}`);
      setResults(page.items.filter((c) => c.id !== sourceId));
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function merge() {
    if (busy || !pick) return;
    setBusy(true);     try {
      await api(`/api/customers/${sourceId}/merge-into/${pick.id}`, { method: 'POST' });
      router.push(`/customers/${pick.id}`);
      router.refresh();
    } catch (err) {
      toast.error(messageFor(err));
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="ap-hint" style={{ margin: '0 0 .75rem' }}>Found a duplicate? Merge this profile into the one you want to keep.</p>
      <form onSubmit={search} className="ap-row" style={{ justifyContent: 'flex-start' }}>
        <label className="ap-sr" htmlFor="merge-q">Find the customer to keep</label>
        <input id="merge-q" className="ap-input" placeholder="Search by name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
        <button className="ap-btn ap-btn-quiet" type="submit" disabled={busy || q.trim().length < 2}>Search</button>
      </form>
      {results && results.length === 0 && <p className="ap-hint">No active customers match.</p>}
      {results && results.length > 0 && !pick && (
        <ul className="ap-plain" style={{ marginTop: '.75rem' }}>
          {results.map((c) => (
            <li key={c.id} className="ap-row" style={{ padding: '.35rem 0' }}>
              <span>{c.fullName} <span className="ap-hint">{[c.email, c.phone].filter(Boolean).join(' · ')}</span></span>
              <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => setPick(c)}>Keep this one</button>
            </li>
          ))}
        </ul>
      )}
      {pick && (
        <div role="alert" className="ap-alert" style={{ marginTop: '.75rem' }}>
          <p style={{ margin: '0 0 .5rem' }}>
            Merge <strong>{sourceName}</strong> into <strong>{pick.fullName}</strong>? Their orders, measurements and notes move to {pick.fullName}.
            {' '}{sourceName} is kept but marked Merged and can no longer be edited. This cannot be undone.
          </p>
          <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" onClick={merge} disabled={busy}>{busy ? 'Merging…' : 'Merge'}</button>
            <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => setPick(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
