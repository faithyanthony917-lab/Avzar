'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { acceptanceRate, barPercents, summaryPath, summaryState, SUMMARY_WINDOWS, type AnalyticsSummary } from '@/lib/storefront-analytics-view-model';
import { toast } from '@/lib/toast';

export function StorefrontAnalyticsManager({ initial }: { initial: AnalyticsSummary | null }) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(initial);
  const [days, setDays] = useState<number>(initial?.days ?? 30);
  const [storefrontId, setStorefrontId] = useState<string>(initial?.storefrontId ?? '');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(initial ? '' : 'The analytics summary could not be loaded. Try again.');
  const [reload, setReload] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; if (initial) return; }
    let cancelled = false;
    setLoading(true); setError('');
    api<AnalyticsSummary>(summaryPath(days, storefrontId || null))
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch((e) => { if (!cancelled) setError(messageFor(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, storefrontId, initial, reload]);

  async function toggle(enabled: boolean) {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await api('/api/business/storefront-analytics/settings', { method: 'PUT', json: { enabled } });
      setSummary((current) => (current ? { ...current, enabled } : current));
      toast.success(enabled ? 'Storefront analytics are on. Visitors are counted only after they accept.' : 'Storefront analytics are off. Nothing is collected.');
    } catch (e) { toast.error(messageFor(e)); } finally { setSaving(false); }
  }

  const state = summary ? summaryState(summary) : null;
  const bars = summary ? barPercents(summary.daily) : [];
  const rate = summary ? acceptanceRate(summary.consent) : null;

  return (
    <div className="ap-stack">
      {error && (
        <div className="ap-row">
          <p className="ap-alert" role="alert">{error}</p>
          {!summary && <button className="ap-btn" disabled={loading} onClick={() => setReload((n) => n + 1)}>{loading ? 'Loading…' : 'Try again'}</button>}
        </div>
      )}
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">Storefront analytics</h2>
        <label className="ap-row">
          <input type="checkbox" checked={summary?.enabled ?? false} disabled={saving || !summary} onChange={(e) => void toggle(e.currentTarget.checked)} />
          <span>Count page views on my storefronts{saving ? ' (saving…)' : ''}</span>
        </label>
        <p className="ap-foot">Off by default. When on, a visitor is counted only after they accept analytics in the privacy banner. Nothing personal is stored: no cookie, IP address, browser details or visitor id, only a daily count per page. Turning this off stops all collection straight away; counts already made are kept.</p>
      </section>

      {summary && (
        <>
          <div className="ap-row">
            <h2 className="ap-h2">Summary</h2>
            <div className="ap-actions">
              <select className="ap-input" aria-label="Period" value={days} disabled={loading} onChange={(e) => setDays(Number(e.target.value))}>
                {SUMMARY_WINDOWS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
              </select>
              {summary.storefronts.length > 1 && (
                <select className="ap-input" aria-label="Storefront" value={storefrontId} disabled={loading} onChange={(e) => setStorefrontId(e.target.value)}>
                  <option value="">All storefronts</option>
                  {summary.storefronts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
            </div>
          </div>
          {loading && <p className="ap-foot" role="status">Loading…</p>}
          {state === 'off' && <p className="ap-foot">Analytics are off, so there is nothing to show yet. Turn them on above to start counting visitors who accept.</p>}
          {state === 'empty' && <p className="ap-foot">No page views in this period yet. Views appear here once visitors accept analytics and open a page.</p>}
          {state === 'data' && (
            <section className="ap-panel ap-stack" aria-busy={loading}>
              <p><strong style={{ fontSize: '1.5rem' }}>{summary.totalViews}</strong> <span className="ap-foot">page views, {summary.fromDay} to {summary.toDay}</span></p>
              <div role="img" aria-label={`Page views per day for the last ${summary.days} days`} style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 96 }}>
                {summary.daily.map((d, i) => (
                  <div key={d.day} title={`${d.day}: ${d.views}`} style={{ flex: 1, height: `${bars[i]}%`, minHeight: d.views > 0 ? 3 : 1, background: 'currentColor', opacity: d.views > 0 ? 0.75 : 0.15 }} />
                ))}
              </div>
              <div className="ap-scroll">
                <table className="ap-table">
                  <thead><tr><th>Page</th><th>Views</th></tr></thead>
                  <tbody>{summary.topPaths.map((p) => <tr key={p.path}><td>{p.path}</td><td>{p.views}</td></tr>)}</tbody>
                </table>
              </div>
            </section>
          )}
          <p className="ap-foot">
            Privacy choices recorded: {summary.consent.accepted} accepted, {summary.consent.rejected} rejected{rate !== null ? ` (${rate}% accepted)` : ''}. Visitors who reject are never counted, so these totals show only part of your traffic.
          </p>
        </>
      )}
    </div>
  );
}
