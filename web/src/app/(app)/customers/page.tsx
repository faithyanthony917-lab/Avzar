import Link from 'next/link';
import { CustomerCsvTools } from '@/components/app/CustomerCsvTools';
import { MeasurementTemplatesTab } from '@/components/app/MeasurementTemplatesTab';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { CustomerSummary, Paged } from '@/lib/customer-types';
import { PAGE_SIZE, STATUS_FILTERS, apiQueryString, listHref, parseListQuery, totalPages } from '@/lib/customers';
import { formatDate } from '@/lib/dates';
import { longDate } from '@/lib/home-view';
import { avatarTone, initials, telHref } from '@/lib/people-view';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Customers · Avzar' };
export const dynamic = 'force-dynamic';

const SORT_LABELS: Record<string, string> = { name: 'Name A–Z', 'name-desc': 'Name Z–A', created: 'Oldest first', 'created-desc': 'Newest first' };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = (await getSession())!;
  if (!can(me, 'customers.view')) return <NoAccess />;
  const raw = await searchParams;
  const tabRaw = Array.isArray(raw.tab) ? raw.tab[0] : raw.tab;
  if (tabRaw === 'templates') return <MeasurementTemplatesTab zone={me.timeZoneId} canManage={can(me, 'measurements.templates')} />;
  const q = parseListQuery(raw);
  const res = await serverGet<Paged<CustomerSummary>>(`/api/customers?${apiQueryString(q)}`);
  if (!res.ok) return <LoadError status={res.status} />;
  const { items, totalCount } = res.data;
  const pages = totalPages(totalCount, res.data.pageSize || PAGE_SIZE);
  const filtered = !!(q.search || q.status);

  const tabLabel = (v: string) => v || 'All';

  return (
    <>
      <header className="ap-pagehead">
        <div>
          <p className="ap-eyebrow">{longDate(me.timeZoneId)}</p>
          <h1>Customers</h1>
        </div>
        <form method="get" action="/customers" className="ap-search" role="search">
          <label className="ap-sr" htmlFor="f-search">Search customers</label>
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input id="f-search" name="search" placeholder="Search customers…" defaultValue={q.search} maxLength={100} />
          {q.status && <input type="hidden" name="status" value={q.status} />}
          {q.sort !== 'name' && <input type="hidden" name="sort" value={q.sort} />}
          <button type="submit" className="ap-sr">Search</button>
        </form>
      </header>

      <div className="ap-toolbar ap-cust-toolbar">
        <div className="ap-cust-tabs" role="group" aria-label="Customers">
          <Link href="/customers" aria-current="page">Clients<span>{totalCount}</span></Link>
          <Link href="/customers?tab=templates">My Templates</Link>
        </div>
        <div className="ap-actions">
          {filtered && <Link href="/customers" className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }}>Clear</Link>}
          {can(me, 'customers.manage') && (
            <Link href="/customers/new" className="ap-btn ap-new-btn" style={{ textDecoration: 'none' }} aria-label="New customer">
              <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M12 5v14M5 12h14" /></svg>New
            </Link>
          )}
        </div>
      </div>

      <details className="ap-more" open={!!q.status}>
        <summary>Status and sort</summary>
        <nav className="ap-subnav" aria-label="Customer status" style={{ marginTop: '.6rem' }}>
          {STATUS_FILTERS.map((st) => (
            <Link key={st || 'all'} href={listHref(q, { status: st, page: 1 })} aria-current={q.status === st ? 'page' : undefined}>
              {tabLabel(st)}{q.status === st && <span>{totalCount}</span>}
            </Link>
          ))}
        </nav>
        <form method="get" action="/customers" className="ap-sortbar">
          {q.search && <input type="hidden" name="search" value={q.search} />}
          {q.status && <input type="hidden" name="status" value={q.status} />}
          <label htmlFor="f-sort" className="ap-hint">Sort</label>
          <select id="f-sort" name="sort" className="ap-input" defaultValue={q.sort}>
            {Object.entries(SORT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="ap-btn ap-btn-quiet ap-btn-sm" type="submit">Apply</button>
        </form>
      </details>

      {can(me, 'customers.manage') && (
        <div className="ap-import">
          <p className="ap-import-line">Keep their fit and details close.</p>
          <CustomerCsvTools />
        </div>
      )}

      <section className="ap-stack" aria-label="Customer list">
        {items.length === 0 ? (
          <p className="ap-panel" style={{ margin: 0 }}>
            {totalCount > 0 ? <>No customers on this page. <Link href={listHref(q, { page: 1 })}>Go to the first page</Link>.</> : filtered ? 'No customers match your search.' : 'No customers yet.'}
          </p>
        ) : (
          <ul className="ap-clist" role="list">
            {items.map((c) => {
              const tel = telHref(c.phone);
              return (
                <li key={c.id} className={c.status === 'Active' ? 'ap-ccard' : 'ap-ccard ap-dim'}>
                  <span className={`ap-av ap-av-${avatarTone(c.fullName)}`} aria-hidden="true">{initials(c.fullName)}</span>
                  <div className="ap-ccard-main">
                    <Link href={`/customers/${c.id}`} className="ap-cname">{c.fullName}</Link>
                    <span className="ap-cline">{c.phone || c.email || 'No contact details'}</span>
                    <span className="ap-cmeta">
                      {c.status !== 'Active' && <span className={c.status === 'Inactive' ? 'ap-badge ap-badge-off' : 'ap-badge'} style={{ marginLeft: 0 }}>{c.status}</span>}
                      <span>{c.orderCount} order{c.orderCount === 1 ? '' : 's'} · Added {formatDate(c.createdAtUtc, me.timeZoneId)}</span>
                    </span>
                  </div>
                  <div className="ap-ccard-actions">
                    {tel && (
                      <a href={tel} className="ap-iconlink" aria-label={`Call ${c.fullName}`}>
                        <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" /></svg>
                      </a>
                    )}
                    {c.status === 'Active' && can(me, 'measurements.record') && (
                      <Link href={`/customers/${c.id}/measurements/new`} className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }}>Measure</Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {totalCount > 0 && (
          <nav className="ap-row ap-pager" aria-label="Pages">
            <span className="ap-hint">{totalCount} customer{totalCount === 1 ? '' : 's'} · page {Math.min(q.page, pages)} of {pages}</span>
            <span className="ap-actions">
              {q.page > 1 && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={listHref(q, { page: q.page - 1 })} rel="prev">Previous</Link>}
              {q.page < pages && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={listHref(q, { page: q.page + 1 })} rel="next">Next</Link>}
            </span>
          </nav>
        )}
        <p className="ap-foot ap-cust-note"><svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg> Messages only go to clients who have given consent.</p>
      </section>
    </>
  );
}
