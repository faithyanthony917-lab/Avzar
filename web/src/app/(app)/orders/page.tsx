import Link from 'next/link';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { ExportCsvButton } from '@/components/app/ExportCsvButton';
import { money } from '@/lib/format';
import { longDate } from '@/lib/home-view';
import { ORDER_STATUSES, type OrderSummary } from '@/lib/order-types';
import { ORDER_PAGE_SIZE, formatDay, isLate, orderApiQuery, orderListHref, parseOrderQuery, statusLabel, todayIn } from '@/lib/orders';
import { getSession, serverGet } from '@/lib/session';
import type { Paged } from '@/lib/customer-types';
import { totalPages } from '@/lib/customers';
import { can } from '@/lib/team';

export const metadata = { title: 'Orders · Avzar' };
export const dynamic = 'force-dynamic';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = (await getSession())!;
  if (!can(me, 'orders.view')) return <NoAccess />;
  const q = parseOrderQuery(await searchParams);
  const TAB_STATUSES = ['Quoted', 'InProduction', 'Ready'] as const;
  const [res, allCount, quotedCount, productionCount, readyCount] = await Promise.all([
    serverGet<Paged<OrderSummary>>(`/api/orders?${orderApiQuery(q)}`),
    serverGet<Paged<unknown>>('/api/orders?page=1&pageSize=1'),
    serverGet<Paged<unknown>>('/api/orders?status=Quoted&page=1&pageSize=1'),
    serverGet<Paged<unknown>>('/api/orders?status=InProduction&page=1&pageSize=1'),
    serverGet<Paged<unknown>>('/api/orders?status=Ready&page=1&pageSize=1'),
  ]);
  if (!res.ok) return <LoadError status={res.status} />;
  const countOf = (r: { ok: boolean; data?: unknown }) => (r.ok ? (r.data as Paged<unknown>).totalCount : null);
  const counts: Record<string, number | null> = { '': countOf(allCount), Quoted: countOf(quotedCount), InProduction: countOf(productionCount), Ready: countOf(readyCount) };
  const tabOrder = ['Quoted', 'InProduction', 'Ready', ...ORDER_STATUSES.filter((st) => !(TAB_STATUSES as readonly string[]).includes(st))];
  const tabLabelOf = (st: string) => (st === 'Quoted' ? 'Quotations' : statusLabel(st));
  const { items, totalCount } = res.data;
  const pages = totalPages(totalCount, res.data.pageSize || ORDER_PAGE_SIZE);
  const filtered = !!(q.search || q.status || q.dueFrom || q.dueTo);
  const today = todayIn(me.timeZoneId);

  const canCreate = can(me, 'orders.manage') && can(me, 'customers.view') && can(me, 'staff.view');
  const keep = (omit: Array<'status' | 'dueFrom' | 'dueTo'> = []) => (
    <>
      {q.status && !omit.includes('status') && <input type="hidden" name="status" value={q.status} />}
      {q.dueFrom && !omit.includes('dueFrom') && <input type="hidden" name="dueFrom" value={q.dueFrom} />}
      {q.dueTo && !omit.includes('dueTo') && <input type="hidden" name="dueTo" value={q.dueTo} />}
    </>
  );

  return (
    <>
      <header className="ap-pagehead">
        <div>
          <p className="ap-eyebrow">{longDate(me.timeZoneId)}</p>
          <h1>Orders</h1>
        </div>
        <form method="get" action="/orders" className="ap-search" role="search">
          <label className="ap-sr" htmlFor="o-search">Search orders</label>
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input id="o-search" name="search" placeholder="Search orders…" defaultValue={q.search} maxLength={100} />
          {keep()}
          <button type="submit" className="ap-sr">Search</button>
        </form>
      </header>

      <div className="ap-toolbar ap-ord-toolbar">
        <nav className="ap-subnav ap-ord-tabs" aria-label="Order status">
          <Link href={orderListHref(q, { status: '', page: 1 })} aria-current={q.status === '' ? 'page' : undefined}>All orders{counts[''] !== null && <span>{counts['']}</span>}</Link>
          {tabOrder.map((st) => (
            <Link key={st} href={orderListHref(q, { status: st, page: 1 })} aria-current={q.status === st ? 'page' : undefined}>
              {tabLabelOf(st)}{(counts[st] ?? (q.status === st ? totalCount : null)) !== null && <span>{counts[st] ?? totalCount}</span>}
            </Link>
          ))}
        </nav>
        <div className="ap-actions">
          <ExportCsvButton path="/api/orders/export" query={orderApiQuery(q)} fileName="orders.csv" />
          {canCreate && (
            <Link href="/orders/new" className="ap-btn ap-new-btn" style={{ textDecoration: 'none' }}>
              <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M12 5v14M5 12h14" /></svg>New Order
            </Link>
          )}
        </div>
      </div>

      <details className="ap-more" open={!!(q.dueFrom || q.dueTo)}>
        <summary>Filter by promised date</summary>
        <form method="get" action="/orders" className="ap-sortbar">
          {q.search && <input type="hidden" name="search" value={q.search} />}
          {keep(['dueFrom', 'dueTo'])}
          <label className="ap-hint" htmlFor="o-from">Due from</label>
          <input id="o-from" name="dueFrom" type="date" className="ap-input" defaultValue={q.dueFrom} />
          <label className="ap-hint" htmlFor="o-to">Due to</label>
          <input id="o-to" name="dueTo" type="date" className="ap-input" defaultValue={q.dueTo} />
          <button className="ap-btn ap-btn-quiet ap-btn-sm" type="submit">Apply</button>
        </form>
      </details>

      <section className="ap-panel ap-table-panel" style={{ marginTop: '1rem' }} aria-label="Order list">
        {items.length === 0 ? (
          <p style={{ margin: 0 }}>
            {totalCount > 0 ? <>No orders on this page. <Link href={orderListHref(q, { page: 1 })}>Go to the first page</Link>.</> : filtered ? 'No orders match your filters.' : 'No orders yet.'}
          </p>
        ) : (
          <>
            <div className="ap-ord-intro">
              <h2>Every piece has a story.</h2>
              <p>Update order stages as each garment takes shape.</p>
            </div>
            <div className="ap-scroll">
              <table className="ap-table">
                <thead><tr><th>Order</th><th>Client</th><th>Garment</th><th>Due date</th><th>Order total</th><th>Paid</th><th>Stage</th></tr></thead>
                <tbody>
                  {items.map((o) => {
                    const late = isLate(o.status, o.promisedDate, today);
                    return (
                      <tr key={o.id} className={o.status === 'Cancelled' ? 'ap-dim' : undefined}>
                        <td><Link href={`/orders/${o.id}`} className="ap-mono"><strong>{o.orderNumber}</strong></Link></td>
                        <td>{o.customerName}{o.priority && o.priority !== 'Normal' && <span className="ap-badge">{o.priority}</span>}</td>
                        <td>{o.garmentCount} garment{o.garmentCount === 1 ? '' : 's'}</td>
                        <td>{formatDay(o.promisedDate)}{late && <span className="ap-badge ap-badge-off">Late</span>}</td>
                        <td><strong>{money(o.total, o.currencyCode)}</strong></td>
                        <td><span className="ap-foot" title="Payments are shown on each order">—</span></td>
                        <td>
                          <span className="ap-stage-cell">
                            <span className={`ap-badge ap-st ap-st-${o.status}`} style={{ marginLeft: 0 }}>{statusLabel(o.status)}</span>
                            <Link href={`/orders/${o.id}`} className="ap-stage-go" aria-label={`Open order ${o.orderNumber}`}><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg></Link>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {totalCount > 0 && (
          <nav className="ap-row ap-pager" aria-label="Pages">
            <span className="ap-hint">{totalCount} order{totalCount === 1 ? '' : 's'}{items[0] ? ` · Values in ${items[0].currencyCode}` : ''}{pages > 1 ? ` · page ${Math.min(q.page, pages)} of ${pages}` : ''}</span>
            <span className="ap-actions">
              {q.page > 1 && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={orderListHref(q, { page: q.page - 1 })} rel="prev">Previous</Link>}
              {q.page < pages && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={orderListHref(q, { page: q.page + 1 })} rel="next">Next</Link>}
            </span>
          </nav>
        )}
      </section>

      <p className="ap-ord-hint">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3" /><path d="M8.12 8.12 12 12" /><path d="M20 4 8.12 15.88" /><circle cx="6" cy="18" r="3" /><path d="M14.8 14.8 20 20" /></svg>
        <span>Quotations, deposits, fittings and delivery are gathered on each order.</span>
        {filtered && <Link href="/orders">Clear filters</Link>}
      </p>
    </>
  );
}
