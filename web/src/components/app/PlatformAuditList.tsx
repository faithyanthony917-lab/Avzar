import { type PlatformAuditPage, when } from '@/lib/platformAdmin';

export type AuditFilters = { action: string; actor: string; from: string; to: string };

export function PlatformAuditList({ page, filters }: { page: PlatformAuditPage; filters: AuditFilters }) {
  const params = (before?: string) => new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), ...(before ? { before } : {}) }).toString();
  const filtered = Object.values(filters).some(Boolean);
  return (
    <section className="ap-panel ap-stack">
      <form method="get" action="/platform-admin/audit" className="ap-row" role="search">
        <label className="ap-filter">Action <input className="ap-input" name="action" defaultValue={filters.action} maxLength={100} placeholder="platform.business.viewed" /></label>
        <label className="ap-filter">Actor <input className="ap-input" name="actor" defaultValue={filters.actor} maxLength={256} /></label>
        <label className="ap-filter">From (UTC) <input className="ap-input" type="date" name="from" defaultValue={filters.from} /></label>
        <label className="ap-filter">To (UTC) <input className="ap-input" type="date" name="to" defaultValue={filters.to} /></label>
        <button type="submit" className="ap-btn">Filter</button>
        {filtered ? <a className="ap-btn ap-btn-quiet" href="/platform-admin/audit">Clear</a> : null}
      </form>
      {page.items.length === 0 ? <p>{filtered ? 'No entries match these filters.' : 'The audit log is empty.'}</p> : (
        <div className="ap-scroll">
          <table className="ap-table">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Subject</th></tr></thead>
            <tbody>{page.items.map((e) => (
              <tr key={e.id}>
                <td>{when(e.createdAtUtc)}</td><td>{e.actorEmail}</td><td>{e.action}</td>
                <td>{e.entityType}{e.entityId ? ` ${e.entityId}` : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {page.next ? <a className="ap-btn ap-btn-quiet" href={`/platform-admin/audit?${params(page.next)}`}>Older entries</a> : null}
    </section>
  );
}
