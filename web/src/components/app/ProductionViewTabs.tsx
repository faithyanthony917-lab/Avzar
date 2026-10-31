import Link from 'next/link';
import { PRODUCTION_VIEWS, VIEW_LABELS, viewHref, type ProductionView } from '@/lib/production-view';

/** Tabs across the manager production screens. Server-rendered: each tab is a link to /tasks?view=… */
export function ProductionViewTabs({ active }: { active: ProductionView }) {
  return (
    <nav className="ap-tabs" aria-label="Production views">
      {PRODUCTION_VIEWS.map((view) => <Link key={view} href={viewHref(view)} aria-current={active === view ? 'page' : undefined}>{VIEW_LABELS[view]}</Link>)}
    </nav>
  );
}

/** A plain GET form that moves the window of a date-based tab. */
export function ProductionRangeForm({ view, from, days, ranges }: { view: ProductionView; from: string; days: number; ranges: readonly number[] }) {
  return (
    <form method="get" action="/tasks" className="ap-panel ap-filter" role="search" aria-label="Date range">
      <input type="hidden" name="view" value={view} />
      <label htmlFor="range-from" className="ap-hint">Start date</label>
      <input id="range-from" name="from" type="date" className="ap-input" defaultValue={from} />
      <label htmlFor="range-days" className="ap-hint">Length</label>
      <select id="range-days" name="days" className="ap-input" defaultValue={String(days)}>
        {ranges.map((n) => <option key={n} value={n}>{n} days</option>)}
      </select>
      <button className="ap-btn" type="submit">Apply</button>
      {from && <Link href={viewHref(view, { days })} className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Back to today</Link>}
    </form>
  );
}

/** Shown instead of a plan-gated tab when the business plan does not include the shop-wide schedule. */
export function PlanBlockedNotice() {
  return (
    <section className="ap-panel ap-stack" role="status">
      <h2 className="ap-h2">Not included in your plan</h2>
      <p style={{ margin: 0 }}>The shop-wide schedule is not part of your current plan, so workload and calendar views are unavailable. The list and board views still work.</p>
      <Link href="/settings/billing" className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none', justifySelf: 'start' }}>View plans and billing</Link>
    </section>
  );
}
