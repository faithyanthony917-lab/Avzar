import Link from 'next/link';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';
import { formatDateTime } from '@/lib/dates';
import { money } from '@/lib/format';
import {
  compactMoney, dueThisWeek, firstName, gettingStarted, greetingFor, homeStats, localHour, longDate,
  monthRanges, newSince, quickActions, sumBalances, todayInZone, trendPercent,
} from '@/lib/home-view';
import { ComingSoon } from '@/components/app/ComingSoon';
import { NavGlyph } from '@/components/app/NavGlyph';
import { ProductionOverviewError, ProductionOverviewSections } from '@/components/app/ProductionOverviewSections';
import type { ProductionOverview } from '@/lib/production-view';
export const metadata = { title: 'Home · Avzar' };
export const dynamic = 'force-dynamic';
type Report = { currencyCode: string; verifiedRevenue: number };
type Paged<T> = { items: T[]; totalCount: number };
type Task = { id: string; title: string; stageName: string; status: string; deadlineUtc: string | null };
type Invoice = { balance: number; currencyCode: string };
type Material = { lowStock: boolean; active?: boolean };

function TaskList({ tasks, zone, link }: { tasks: Task[]; zone: string; link: boolean }) {
  return (
    <ul className="ap-tasklist">
      {tasks.map((t) => (
        <li key={t.id}>
          <span>
            <strong>{t.title}</strong>
            <span className="ap-foot" style={{ display: 'block' }}>{t.stageName} · {t.status} · {t.deadlineUtc ? formatDateTime(t.deadlineUtc, zone) : 'No deadline'}</span>
          </span>
          {link && <Link href={`/tasks/${t.id}`} className="ap-tasklink">View</Link>}
        </li>
      ))}
    </ul>
  );
}

export default async function DashboardPage() {
  const user = (await getSession())!;
  const today = todayInZone(user.timeZoneId);
  const month = monthRanges(today);
  const rangeQuery = (from: string, to: string) => `/api/reports/summary?from=${from}&to=${to}`;
  const [report, monthReport, prevReport, orders, inProduction, myTasks, customers, shopTasks, overview, invoices, storefronts, materials] = await Promise.all([
    can(user, 'reports.view') ? serverGet<Report>('/api/reports/summary') : Promise.resolve(null),
    can(user, 'reports.view') ? serverGet<Report>(rangeQuery(month.from, month.to)) : Promise.resolve(null),
    can(user, 'reports.view') ? serverGet<Report>(rangeQuery(month.prevFrom, month.prevTo)) : Promise.resolve(null),
    can(user, 'orders.view') ? serverGet<Paged<unknown>>('/api/orders?page=1&pageSize=1') : Promise.resolve(null),
    can(user, 'orders.view') ? serverGet<Paged<{ promisedDate: string }>>('/api/orders?status=InProduction&page=1&pageSize=100') : Promise.resolve(null),
    can(user, 'tasks.work') ? serverGet<Paged<Task>>('/api/my/tasks?page=1&pageSize=5&show=open') : Promise.resolve(null),
    can(user, 'customers.view') ? serverGet<Paged<{ createdAtUtc: string }>>('/api/customers?page=1&pageSize=100&sort=created&descending=true') : Promise.resolve(null),
    can(user, 'tasks.view') ? serverGet<Paged<Task>>('/api/tasks?page=1&pageSize=5') : Promise.resolve(null),
    can(user, 'tasks.view') ? serverGet<ProductionOverview>('/api/production/overview') : Promise.resolve(null),
    can(user, 'invoices.view') ? serverGet<Paged<Invoice>>('/api/invoices?outstanding=true&page=1&pageSize=100') : Promise.resolve(null),
    can(user, 'storefront.view') ? serverGet<unknown[]>('/api/storefronts') : Promise.resolve(null),
    can(user, 'inventory.view') ? serverGet<Material[]>('/api/inventory') : Promise.resolve(null),
  ]);
  const metrics = report?.ok ? report.data : null;
  const total = (r: { ok: boolean; data?: unknown } | null): number | null => (r && r.ok ? (r.data as Paged<unknown>).totalCount : null);
  const customerCount = total(customers);
  const orderCount = total(orders);
  const inProductionCount = total(inProduction);
  const storefrontCount = storefronts?.ok && Array.isArray(storefronts.data) ? storefronts.data.length : null;
  const currency = metrics?.currencyCode ?? '';

  const outstandingAmount = invoices?.ok && metrics ? sumBalances(invoices.data.items, invoices.data.totalCount, metrics.currencyCode) : null;
  const invoiceCount = total(invoices);
  const outstandingText = outstandingAmount !== null ? (money(outstandingAmount, currency) ?? '—') : invoiceCount !== null ? `${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} with a balance` : null;

  const monthRevenue = monthReport?.ok ? compactMoney(monthReport.data.verifiedRevenue, monthReport.data.currencyCode) : null;
  const trend = monthReport?.ok && prevReport?.ok ? trendPercent(monthReport.data.verifiedRevenue, prevReport.data.verifiedRevenue) : null;
  const dueCount = inProduction?.ok && inProduction.data.items.length === inProduction.data.totalCount ? dueThisWeek(inProduction.data.items.map((o) => o.promisedDate), today) : null;
  const newCustomers = customers?.ok ? newSince(customers.data.items.map((c) => c.createdAtUtc), customers.data.totalCount, month.from, user.timeZoneId) : null;
  const reorderCount = materials?.ok && Array.isArray(materials.data) ? materials.data.filter((m) => m.lowStock && m.active !== false).length : null;

  const actions = quickActions((p) => can(user, p));
  const stats = homeStats({ inProduction: inProductionCount, dueThisWeek: dueCount, monthRevenue, trend, customers: customerCount, newCustomers, reorder: reorderCount });
  const start = gettingStarted({ customers: customerCount, orders: orderCount, storefronts: storefrontCount });
  const greeting = greetingFor(localHour(user.timeZoneId));

  return (
    <div className="ap-stack">
      <header className="ap-home-head">
        <div>
          <p className="ap-eyebrow">{longDate(user.timeZoneId, new Date(), ' · ')}</p>
          <h1>Hi, {firstName(user.fullName)}</h1>
          <p className="ap-foot" style={{ margin: 0 }}>{greeting}. Here’s your studio today.</p>
        </div>
        <Link href="/notifications" className="ap-home-alert" aria-label="Open notifications"><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></svg></Link>
      </header>

      {metrics && (
        <section className="ap-banner" aria-label="Revenue">
          <div className="ap-banner-label">Total revenue · last 30 days</div>
          <strong className="ap-banner-value">{money(metrics.verifiedRevenue, metrics.currencyCode) ?? '—'}</strong>
          {(outstandingText !== null || inProductionCount !== null) && <div className="ap-banner-rule" aria-hidden="true" />}
          <div className="ap-banner-foot">
            {outstandingText !== null && <div><span className="ap-banner-sublabel">Outstanding</span><strong className="ap-banner-sub">{outstandingText}</strong></div>}
            {inProductionCount !== null && <Link href="/orders?status=InProduction" className="ap-banner-chip" style={{ textDecoration: 'none', color: 'inherit' }}>{inProductionCount} ongoing</Link>}
          </div>
        </section>
      )}

      {actions.length > 0 && (
        <nav aria-label="Quick actions" className="ap-qa">
          {actions.map((a, i) => <Link key={a.label} href={a.href} className={`${i === 0 ? 'ap-qa-item ap-qa-primary' : 'ap-qa-item'} ap-qa-${a.label.toLowerCase().replace(/\s+/g, '-')}`}><NavGlyph href={a.label === 'Add Client' ? '/customers' : a.icon} /><span>{a.label}</span></Link>)}
        </nav>
      )}

      {stats.length > 0 && (
        <ul className="ap-statgrid ap-statgrid-2" aria-label="At a glance">
          {stats.map((s) => (
            <li key={s.key}>
              <Link href={s.href} className="ap-panel ap-stat">
                <span className="ap-foot">{s.label}</span>
                <strong>{s.value}</strong>
                {s.sub && <span className={`ap-stat-sub ap-tone-${s.tone}`}>{s.sub}{s.key === 'in-production' && <svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4, verticalAlign: -1 }}><path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {start.items.length > 0 && !start.allDone && (
        <section className="ap-panel ap-gs" aria-labelledby="gs">
          <div className="ap-row"><h2 id="gs" className="ap-h2" style={{ margin: 0 }}>Getting Started</h2><span className="ap-eyebrow" style={{ margin: 0 }}>Your next few stitches</span></div>
          <ul className="ap-gs-list">
            {start.items.map((s) => (
              <li key={s.key} className={s.done ? 'ap-step-done' : undefined}>
                <Link href={s.href} className="ap-gs-row">
                  <NavGlyph href={s.key === 'order' ? '/quick/package' : s.href} />
                  <span className="ap-grow"><strong>{s.title}</strong>{s.done && <span className="ap-sr"> (done)</span>}<span className="ap-foot" style={{ display: 'block' }}>{s.detail}</span></span>
                  <span className="ap-gs-end" aria-hidden="true">{s.done ? '✓' : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
          {shopTasks?.ok && shopTasks.data.items[0] && (
            <div className="ap-today">
              <span className="ap-today-dot" aria-hidden="true" />
              <span className="ap-grow"><strong>Today in the workroom</strong><span>{shopTasks.data.items[0].title}</span></span>
              <Link href={`/tasks/${shopTasks.data.items[0].id}`} className="ap-tasklink">View</Link>
            </div>
          )}
        </section>
      )}

      {shopTasks?.ok && (
        <section className="ap-panel ap-stack" aria-labelledby="shop-tasks">
          <div className="ap-row"><h2 id="shop-tasks" className="ap-h2" style={{ margin: 0 }}>In the workroom</h2><Link href="/tasks" className="ap-tasklink">All production</Link></div>
          {shopTasks.data.items.length === 0 ? <p className="ap-foot" style={{ margin: 0 }}>No production tasks yet.</p> : <TaskList tasks={shopTasks.data.items} zone={user.timeZoneId} link />}
        </section>
      )}

      <section className="ap-invite" aria-labelledby="invite-maker">
        <NavGlyph href="/ai-studio" />
        <div className="ap-grow">
          <p className="ap-eyebrow">A little room to grow</p>
          <h2 id="invite-maker" className="ap-h2" style={{ margin: 0 }}>Invite a maker.<br />Make good work together.</h2>
        </div>
        <div className="ap-actions">
          {can(user, 'staff.manage') && can(user, 'staff.view') && <Link href="/staff" className="ap-btn ap-btn-sm" style={{ textDecoration: 'none' }}>Invite staff</Link>}
          <ComingSoon className="ap-btn ap-btn-quiet ap-btn-sm" message="Coming soon. Sharing Avzar is not available yet.">Share Avzar</ComingSoon>
        </div>
      </section>

      {overview && (overview.ok ? <ProductionOverviewSections overview={overview.data} /> : <ProductionOverviewError />)}

      {myTasks?.ok && (
        <section className="ap-panel ap-stack" aria-labelledby="my-tasks">
          <div className="ap-row"><h2 id="my-tasks" className="ap-h2" style={{ margin: 0 }}>My assigned work</h2><Link href="/tasks" className="ap-tasklink">Open production</Link></div>
          {myTasks.data.items.length === 0 ? <p className="ap-foot" style={{ margin: 0 }}>No open tasks assigned to you.</p> : <TaskList tasks={myTasks.data.items} zone={user.timeZoneId} link={false} />}
        </section>
      )}
    </div>
  );
}
