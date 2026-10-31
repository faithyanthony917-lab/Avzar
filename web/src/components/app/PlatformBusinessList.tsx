import { type PlatformBusinessPage, when } from '@/lib/platformAdmin';

export function PlatformBusinessList({ page, q }: { page: PlatformBusinessPage; q: string }) {
  const olderHref = page.next ? `/platform-admin/businesses?${new URLSearchParams({ ...(q ? { q } : {}), before: page.next }).toString()}` : null;
  return (
    <section className="ap-panel ap-stack">
      <form method="get" action="/platform-admin/businesses" className="ap-row" role="search">
        <label className="ap-filter">Name or contact email <input className="ap-input" name="q" defaultValue={q} maxLength={100} /></label>
        <button type="submit" className="ap-btn">Search</button>
        {q ? <a className="ap-btn ap-btn-quiet" href="/platform-admin/businesses">Clear</a> : null}
      </form>
      {page.items.length === 0 ? <p>{q ? 'No business matches that search.' : 'There are no businesses yet.'}</p> : (
        <div className="ap-scroll">
          <table className="ap-table">
            <thead><tr><th>Business</th><th>Contact</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {page.items.map((b) => (
                <tr key={b.id}>
                  <td><a href={`/platform-admin/businesses/${b.id}`}>{b.name}</a></td>
                  <td>{b.contactEmail ?? '—'}</td>
                  <td>{b.isActive ? 'Active' : 'Suspended'}</td>
                  <td>{when(b.createdAtUtc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {olderHref ? <a className="ap-btn ap-btn-quiet" href={olderHref}>Older businesses</a> : null}
    </section>
  );
}
