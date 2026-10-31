import { PageHead } from '@/components/app/PageHead';
import Link from 'next/link';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { auditDetailsText, auditPageCount, type AuditPage } from '@/lib/audit-view-model';
import { can } from '@/lib/team';
import { getSession, serverGet } from '@/lib/session';

export const metadata = { title: 'Audit log · Avzar' };
export const dynamic = 'force-dynamic';

type Query = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const dayStart = (value: string) => `${value}T00:00:00.000Z`;
function isValidDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function nextDayStart(value: string) {
  if (!isValidDay(value)) return '';
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Query> }) {
  const me = (await getSession())!;
  if (!can(me, 'audit.view')) return <NoAccess />;
  const query = await searchParams;
  const page = Math.max(1, Number.parseInt(first(query.page) ?? '1', 10) || 1);
  const pageSize = 25;
  const action = (first(query.action) ?? '').trim().slice(0, 120);
  const entityType = (first(query.entityType) ?? '').trim().slice(0, 120);
  const from = (first(query.from) ?? '').trim();
  const to = (first(query.to) ?? '').trim();
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (action) params.set('action', action);
  if (entityType) params.set('entityType', entityType);
  if (isValidDay(from)) params.set('fromUtc', dayStart(from));
  if (isValidDay(to)) params.set('toUtc', nextDayStart(to));
  const result = await serverGet<AuditPage>(`/api/audit?${params.toString()}`);
  if (!result.ok) return <LoadError status={result.status} />;
  const data = result.data;
  const pages = auditPageCount(data.totalCount, data.pageSize);
  const pageHref = (next: number) => {
    const p = new URLSearchParams();
    if (action) p.set('action', action);
    if (entityType) p.set('entityType', entityType);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    p.set('page', String(next));
    return `/audit?${p.toString()}`;
  };

  return <div className="ap-stack">
    <PageHead title="Audit log" intro="Review recorded changes and actions in this business. Audit entries are read-only and scoped to your active business." zone={me.timeZoneId} />
    <form method="get" className="ap-panel ap-filter">
      <label htmlFor="audit-action">Action</label><input id="audit-action" className="ap-input" name="action" maxLength={120} placeholder="e.g. order.created" defaultValue={action} />
      <label htmlFor="audit-entity">Entity type</label><input id="audit-entity" className="ap-input" name="entityType" maxLength={120} placeholder="e.g. Customer" defaultValue={entityType} />
      <label htmlFor="audit-from">From (UTC)</label><input id="audit-from" className="ap-input" type="date" name="from" defaultValue={from} />
      <label htmlFor="audit-to">To (UTC)</label><input id="audit-to" className="ap-input" type="date" name="to" defaultValue={to} />
      <button className="ap-btn">Filter</button>
      <Link className="ap-btn ap-btn-quiet" href="/audit">Clear filters</Link>
    </form>
    <section className="ap-panel ap-stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}><h2 className="ap-h2">Recorded events</h2><p className="ap-foot" style={{ margin: 0 }}>{data.totalCount} {data.totalCount === 1 ? 'event' : 'events'} · Page {data.page}{pages ? ` of ${pages}` : ''}</p></div>
      {data.items.length === 0 ? <p className="ap-foot">No audit events match these filters.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>{data.items.map((entry) => <tr key={entry.id}>
        <td style={{ whiteSpace: 'nowrap' }}>{new Date(entry.createdAtUtc).toISOString().replace('T', ' ').replace('Z', '')}</td>
        <td>{entry.actorName || (entry.actorUserId ? 'User' : 'System')}</td>
        <td><code>{entry.action}</code></td>
        <td>{entry.entityType || '—'}{entry.entityId ? <><br /><small>{entry.entityId}</small></> : null}</td>
        <td><details><summary>View details</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '24rem' }}>{auditDetailsText(entry.detailsJson)}</pre></details></td>
      </tr>)}</tbody></table></div>}
      <nav aria-label="Audit log pagination" style={{ display: 'flex', gap: '.75rem', justifyContent: 'space-between', alignItems: 'center' }}>
        {data.page > 1 ? <Link className="ap-btn ap-btn-quiet" href={pageHref(data.page - 1)}>Previous</Link> : <span />}
        {data.page < pages ? <Link className="ap-btn" href={pageHref(data.page + 1)}>Next</Link> : <span />}
      </nav>
    </section>
  </div>;
}
