/** Pure helpers for the Home screen. No I/O, so they are unit-tested without rendering. */

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

export function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Hour (0-23) in the business's time zone; an unknown zone id falls back to UTC. */
export function localHour(timeZoneId: string, now: Date = new Date()): number {
  for (const timeZone of [timeZoneId, 'UTC']) {
    try {
      const part = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).formatToParts(now).find((p) => p.type === 'hour');
      if (part) return Number(part.value) % 24;
    } catch { /* try the next zone */ }
  }
  return now.getUTCHours();
}

/** "Tuesday, 27 October 2026" in the business's zone (UTC for an unknown zone). `sep` joins the weekday and the date. */
export function longDate(timeZoneId: string, now: Date = new Date(), sep = ', '): string {
  for (const timeZone of [timeZoneId, 'UTC']) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone }).formatToParts(now);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      return `${get('weekday')}${sep}${get('day')} ${get('month')} ${get('year')}`;
    } catch { /* try the next zone */ }
  }
  return '';
}

/** Today's date as yyyy-MM-dd in the given zone (UTC for an unknown zone). */
export function todayInZone(timeZoneId: string, now: Date = new Date()): string {
  for (const timeZone of [timeZoneId, 'UTC']) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(now);
      const get = (type: string) => parts.find((p) => p.type === type)?.value;
      const [y, m, d] = [get('year'), get('month'), get('day')];
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch { /* try the next zone */ }
  }
  return now.toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Counts are shown with two digits (04), as in the design. */
export const pad2 = (n: number): string => (n >= 0 && n < 10 ? `0${n}` : String(n));

/** This month so far, and the same days of last month, as report ranges. */
export function monthRanges(today: string): { from: string; to: string; prevFrom: string; prevTo: string } {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const prevLastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { from: `${y}-${pad(m)}-01`, to: today, prevFrom: `${py}-${pad(pm)}-01`, prevTo: `${py}-${pad(pm)}-${pad(Math.min(d, prevLastDay))}` };
}

export interface Trend { text: string; up: boolean }

/** Change against the same days last month. `null` when last month has nothing to compare with. */
export function trendPercent(current: number, previous: number): Trend | null {
  if (!Number.isFinite(current) || !(previous > 0)) return null;
  const pct = Math.round(((current - previous) / previous) * 1000) / 10;
  if (pct === 0) return { text: 'Same as last month', up: true };
  return { text: `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs last month`, up: pct > 0 };
}

/** ₦1.84m style figure for a card. Small amounts keep their digits. */
export function compactMoney(amount: number, currency: string | null | undefined): string {
  let symbol = '';
  if (currency) {
    try { symbol = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency; } catch { symbol = currency; }
    if (/^[A-Za-z]+$/.test(symbol)) symbol += ' ';
  }
  const abs = Math.abs(amount);
  const body = abs >= 1e9 ? `${(abs / 1e9).toFixed(2)}b` : abs >= 1e6 ? `${(abs / 1e6).toFixed(2)}m` : abs >= 1e4 ? `${(abs / 1e3).toFixed(1)}k` : new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(abs);
  return `${amount < 0 ? '-' : ''}${symbol}${body}`;
}

/** Orders whose promised date falls from today to six days ahead. */
export function dueThisWeek(promisedDates: string[], today: string): number {
  const last = addDaysIso(today, 6);
  return promisedDates.filter((d) => d >= today && d <= last).length;
}

/** Sum of invoice balances, only when the list is complete and in one currency; otherwise `null` (never a partial figure). */
export function sumBalances(items: Array<{ balance: number; currencyCode: string }>, totalCount: number, currency: string): number | null {
  if (items.length !== totalCount) return null;
  if (items.some((i) => i.currencyCode !== currency)) return null;
  return items.reduce((cents, i) => cents + Math.round(i.balance * 100), 0) / 100;
}

/** Customers created on or after `fromDate` (yyyy-MM-dd, in the zone). `null` when the list may have more of them than it holds. */
export function newSince(createdUtc: string[], totalCount: number, fromDate: string, timeZoneId: string): number | null {
  const count = createdUtc.filter((c) => todayInZone(timeZoneId, new Date(c)) >= fromDate).length;
  if (count === createdUtc.length && createdUtc.length < totalCount) return null;
  return count;
}

export interface QuickAction { href: string; label: string; icon: string }

/** Shortcuts to pages that already exist. Each follows the permission rule of the page it opens. */
export function quickActions(has: (permission: string) => boolean): QuickAction[] {
  const out: QuickAction[] = [];
  if (has('orders.manage') && has('customers.view') && has('staff.view')) out.push({ href: '/orders/new', label: 'New Order', icon: '/orders/new' });
  if (has('customers.view')) out.push({ href: '/customers', label: 'Measure', icon: '/quick/measure' });
  if (has('measurements.templates')) out.push({ href: '/customers?tab=templates', label: 'New Template', icon: '/quick/template' });
  if (has('customers.manage')) out.push({ href: '/customers/new', label: 'Add Client', icon: '/customers/new' });
  if (has('invoices.manage')) out.push({ href: '/finance/invoices/new', label: 'Invoice', icon: '/finance/invoices/new' });
  return out;
}

export interface HomeStat { key: string; label: string; value: string; sub: string | null; tone: 'good' | 'warn' | 'plain'; href: string }

/** A figure the user may not see, or that failed to load, is `null` and its card is left out (never shown as zero). */
export function homeStats(i: {
  inProduction: number | null;
  dueThisWeek: number | null;
  monthRevenue: string | null;
  trend: Trend | null;
  customers: number | null;
  newCustomers: number | null;
  reorder: number | null;
}): HomeStat[] {
  const cards: HomeStat[] = [];
  if (i.inProduction !== null) cards.push({ key: 'in-production', label: 'Orders in progress', value: pad2(i.inProduction), sub: i.dueThisWeek !== null ? `${i.dueThisWeek} due this week` : null, tone: 'plain', href: '/orders?status=InProduction' });
  if (i.monthRevenue !== null) cards.push({ key: 'month-revenue', label: 'Revenue this month', value: i.monthRevenue, sub: i.trend ? i.trend.text : 'This month so far', tone: i.trend ? (i.trend.up ? 'good' : 'warn') : 'plain', href: '/reports' });
  if (i.customers !== null) cards.push({ key: 'customers', label: 'Clients in your book', value: String(i.customers), sub: i.newCustomers !== null ? `${i.newCustomers} new this month` : null, tone: 'plain', href: '/customers' });
  if (i.reorder !== null) cards.push({ key: 'reorder', label: 'Materials to reorder', value: pad2(i.reorder), sub: i.reorder > 0 ? 'Check your shelves' : 'All stocked up', tone: i.reorder > 0 ? 'warn' : 'plain', href: '/inventory' });
  return cards;
}

export interface ChecklistItem { key: string; title: string; detail: string; href: string; done: boolean }

/** `null` means the user cannot see that count (or it failed to load), so the step is not shown. */
export function gettingStarted(counts: { customers: number | null; orders: number | null; storefronts: number | null }): { items: ChecklistItem[]; allDone: boolean } {
  const items: ChecklistItem[] = [];
  if (counts.storefronts !== null) items.push({ key: 'storefront', title: 'Create your storefront', detail: 'Launch your free online storefront', href: '/storefront', done: counts.storefronts > 0 });
  if (counts.customers !== null) items.push({ key: 'customer', title: 'Add your first client', detail: 'Save their details and measurements', href: '/customers', done: counts.customers > 0 });
  if (counts.orders !== null) items.push({ key: 'order', title: 'Create your first order', detail: 'Track delivery, fittings and payments', href: '/orders', done: counts.orders > 0 });
  return { items, allDone: items.length > 0 && items.every((i) => i.done) };
}
