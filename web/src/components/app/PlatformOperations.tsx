'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { Pager, usePaged } from '@/components/app/Pager';
import { toast } from '@/lib/toast';

type Flag = { key: string; description: string; enabled: boolean; updatedAtUtc: string | null; updatedByEmail: string | null };
type Job = { kind: 'notification' | 'push' | 'worker-summary' | 'appointment-reminder' | 'email'; id: string; businessId: string; eventType: string; status: string; attempts: number; nextAttemptUtc: string | null; createdAtUtc: string; lastError: string | null };

export function PlatformOperations({ initialFlags, initialJobs }: { initialFlags: Flag[]; initialJobs: Job[] }) {
  const [flags, setFlags] = useState(initialFlags);
  const [jobs, setJobs] = useState(initialJobs);
  const [status, setStatus] = useState('Failed');
  // The status filter the rows on screen were loaded for. The page is rendered with the "Failed" rows.
  const [shownStatus, setShownStatus] = useState('Failed');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const pagedFlags = usePaged(flags);
  const pagedJobs = usePaged(jobs);
  const latestRequest = useRef(0);
  const reloadJobs = useCallback(async () => {
    // Only the newest request may change the screen, so a slow answer for an older filter cannot overwrite a newer one.
    const request = ++latestRequest.current;
    setLoading(true);
    try {
      const result = await api<{ items: Job[] }>(`/api/platform-admin/background-jobs?limit=250${status ? `&status=${encodeURIComponent(status)}` : ''}`);
      if (request === latestRequest.current) { setJobs(result.items ?? []); setShownStatus(status); setError(''); }
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [status]);
  useEffect(() => { void reloadJobs().catch((e) => setError(messageFor(e))); }, [reloadJobs]);

  async function toggle(flag: Flag) {
    setBusy(flag.key); setError('');
    try {
      const updated = await api<{ key: string; enabled: boolean }>(`/api/platform-admin/feature-flags/${encodeURIComponent(flag.key)}`, { method: 'PUT', json: { enabled: !flag.enabled } });
      setFlags((current) => current.map((item) => item.key === updated.key ? { ...item, enabled: updated.enabled, updatedAtUtc: new Date().toISOString() } : item));
      toast.success(`${flag.key} ${updated.enabled ? 'enabled' : 'disabled'}.`);
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(''); }
  }

  async function retry(job: Job) {
    if (busy || !window.confirm(`Retry failed ${job.kind} job ${job.id}?`)) return;
    setBusy(job.id); setError('');
    try {
      await api(`/api/platform-admin/background-jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST', json: { kind: job.kind } });
      toast.success('The failed job was queued for retry.');
      await reloadJobs();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(''); }
  }

  return <div className="ap-stack">
    {error && <p className="ap-alert" role="alert">{error}</p>}
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Feature flags</h2><p className="ap-foot">Global platform switches. Disabling a flag prevents new feature use only where the application explicitly checks that flag; it does not reverse existing records.</p>
      {flags.length === 0 ? <p>No feature flags are configured.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Flag</th><th>Status</th><th>Last changed</th><th>Action</th></tr></thead><tbody>{pagedFlags.slice.map((flag) => <tr key={flag.key}><td><strong>{flag.key}</strong><div className="ap-foot">{flag.description}</div></td><td>{flag.enabled ? 'Enabled' : 'Disabled'}</td><td>{flag.updatedAtUtc ? new Date(flag.updatedAtUtc).toLocaleString() : 'Not changed'}</td><td><button type="button" className="ap-btn ap-btn-quiet" disabled={!!busy} onClick={() => void toggle(flag)}>{busy === flag.key ? 'Saving…' : flag.enabled ? 'Disable' : 'Enable'}</button></td></tr>)}</tbody></table></div>}
      <Pager page={pagedFlags.page} pages={pagedFlags.pages} total={pagedFlags.total} size={pagedFlags.size} onPage={pagedFlags.setPage} label="Feature flags pages" />
    </section>
    <section className="ap-panel ap-stack" aria-busy={loading}><div className="ap-row"><h2 className="ap-h2">Background jobs</h2><label className="ap-filter">Status <select className="ap-input" value={status} disabled={!!busy || loading} onChange={(e) => setStatus(e.target.value)}><option value="Failed">Failed</option><option value="Pending">Pending</option><option value="Leased">Leased</option><option value="Sent">Sent</option><option value="Accepted">Accepted</option><option value="Skipped">Skipped</option><option value="">All statuses</option></select></label></div>
      <p className="ap-foot">Notification and push delivery status. A retry is offered only for a job that is currently failed and is rechecked under a database lock.</p>
      {loading && <p className="ap-foot" role="status">Loading jobs…</p>}
      {shownStatus !== status ? (loading || !error ? null : <p>Jobs for this filter are not loaded. Use Refresh jobs to try again.</p>) : jobs.length === 0 ? <p>No jobs match this filter.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Type / event</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Created</th><th>Action</th></tr></thead><tbody>{pagedJobs.slice.map((job) => <tr key={`${job.kind}:${job.id}`}><td>{job.kind}<div className="ap-foot">{job.eventType}</div><div className="ap-foot">{job.id}</div></td><td>{job.status}</td><td>{job.attempts}</td><td>{job.lastError ?? '—'}</td><td>{new Date(job.createdAtUtc).toLocaleString()}</td><td>{job.status === 'Failed' && (job.kind === 'notification' || job.kind === 'push') ? <button type="button" className="ap-btn ap-btn-quiet" disabled={!!busy} onClick={() => void retry(job)}>{busy === job.id ? 'Retrying…' : 'Retry'}</button> : '—'}</td></tr>)}</tbody></table></div>}
      {shownStatus === status && <Pager page={pagedJobs.page} pages={pagedJobs.pages} total={pagedJobs.total} size={pagedJobs.size} onPage={pagedJobs.setPage} label="Background jobs pages" />}
      <button type="button" className="ap-btn ap-btn-quiet" disabled={!!busy || loading} onClick={() => void reloadJobs().catch((e) => setError(messageFor(e)))}>{loading ? 'Loading…' : 'Refresh jobs'}</button>
    </section>
  </div>;
}
