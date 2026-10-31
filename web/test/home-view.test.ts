import { describe, expect, it } from 'vitest';
import {
  addDaysIso, compactMoney, dueThisWeek, firstName, gettingStarted, greetingFor, homeStats, localHour, longDate,
  monthRanges, newSince, pad2, quickActions, sumBalances, todayInZone, trendPercent,
} from '../src/lib/home-view';

const stats = { inProduction: 4, dueThisWeek: 2, monthRevenue: '₦1.84m', trend: { text: '↑ 12.8% vs last month', up: true }, customers: 128, newCustomers: 8, reorder: 3 };

describe('home view helpers (workshop Home)', () => {
  it('takes the first word of the name', () => {
    expect(firstName('  Adesuwa Okon ')).toBe('Adesuwa');
    expect(firstName('')).toBe('');
  });

  it('greets by the hour in the business time zone', () => {
    expect([greetingFor(0), greetingFor(11), greetingFor(12), greetingFor(17), greetingFor(18), greetingFor(23)])
      .toEqual(['Good morning', 'Good morning', 'Good afternoon', 'Good afternoon', 'Good evening', 'Good evening']);
    const noonUtc = new Date('2026-10-27T12:30:00Z');
    expect(localHour('UTC', noonUtc)).toBe(12);
    expect(localHour('Africa/Lagos', noonUtc)).toBe(13);
    expect(localHour('Not/AZone', noonUtc)).toBe(12);
  });

  it('formats the date with the year in the zone, falling back to UTC for an unknown zone', () => {
    const late = new Date('2026-10-27T23:30:00Z');
    expect(longDate('UTC', late)).toBe('Tuesday, 27 October 2026');
    expect(longDate('Africa/Lagos', late)).toBe('Wednesday, 28 October 2026');
    expect(longDate('Not/AZone', late)).toBe('Tuesday, 27 October 2026');
    expect(longDate('UTC', late, ' · ')).toBe('Tuesday · 27 October 2026');
    expect(todayInZone('Africa/Lagos', late)).toBe('2026-10-28');
    expect(todayInZone('Not/AZone', late)).toBe('2026-10-27');
  });

  it('builds this month and last month ranges, clamping the day', () => {
    expect(monthRanges('2026-10-27')).toEqual({ from: '2026-10-01', to: '2026-10-27', prevFrom: '2026-09-01', prevTo: '2026-09-27' });
    expect(monthRanges('2026-03-31').prevTo).toBe('2026-02-28');
    expect(monthRanges('2026-01-15')).toMatchObject({ prevFrom: '2025-12-01', prevTo: '2025-12-15' });
    expect(addDaysIso('2026-10-30', 3)).toBe('2026-11-02');
  });

  it('works out the revenue trend, and shows none when last month has nothing to compare', () => {
    expect(trendPercent(112.8, 100)).toEqual({ text: '↑ 12.8% vs last month', up: true });
    expect(trendPercent(50, 100)).toEqual({ text: '↓ 50% vs last month', up: false });
    expect(trendPercent(100, 100)?.text).toBe('Same as last month');
    expect(trendPercent(100, 0)).toBeNull();
  });

  it('shortens money for a card', () => {
    expect(compactMoney(1842500, 'NGN')).toBe('₦1.84m');
    expect(compactMoney(25000, 'NGN')).toBe('₦25.0k');
    expect(compactMoney(950, 'NGN')).toBe('₦950');
    expect(compactMoney(950, null)).toBe('950');
    expect(pad2(4)).toBe('04');
    expect(pad2(128)).toBe('128');
  });

  it('counts orders due from today to six days ahead', () => {
    expect(dueThisWeek(['2026-10-26', '2026-10-27', '2026-11-02', '2026-11-03'], '2026-10-27')).toBe(2);
  });

  it('sums invoice balances only for a complete list in one currency', () => {
    const items = [{ balance: 100.1, currencyCode: 'NGN' }, { balance: 200.2, currencyCode: 'NGN' }];
    expect(sumBalances(items, 2, 'NGN')).toBe(300.3);
    expect(sumBalances(items, 3, 'NGN')).toBeNull();
    expect(sumBalances([...items, { balance: 1, currencyCode: 'USD' }], 3, 'NGN')).toBeNull();
    expect(sumBalances([], 0, 'NGN')).toBe(0);
  });

  it('counts new customers this month, or says it cannot tell', () => {
    const made = ['2026-10-20T10:00:00Z', '2026-10-02T10:00:00Z', '2026-09-20T10:00:00Z'];
    expect(newSince(made, 3, '2026-10-01', 'UTC')).toBe(2);
    expect(newSince(['2026-10-20T10:00:00Z'], 5, '2026-10-01', 'UTC')).toBeNull();
  });

  it('offers only the quick actions a user may use, in the design order', () => {
    expect(quickActions(() => true).map((a) => a.label)).toEqual(['New Order', 'Measure', 'New Template', 'Add Client', 'Invoice']);
    expect(quickActions(() => false)).toEqual([]);
    const has = (list: string[]) => (p: string) => list.includes(p);
    expect(quickActions(has(['orders.manage', 'customers.view'])).map((a) => a.label)).toEqual(['Measure']);
    expect(quickActions(has(['orders.manage', 'customers.view', 'staff.view'])).map((a) => a.label)).toEqual(['New Order', 'Measure']);
    expect(quickActions(has(['measurements.templates'])).map((a) => a.href)).toEqual(['/customers?tab=templates']);
    expect(quickActions(has(['invoices.manage'])).map((a) => a.href)).toEqual(['/finance/invoices/new']);
  });

  it('builds the four cards in the design order and leaves out an unknown figure instead of showing zero', () => {
    expect(homeStats(stats).map((c) => c.key)).toEqual(['in-production', 'month-revenue', 'customers', 'reorder']);
    expect(homeStats(stats).map((c) => c.value)).toEqual(['04', '₦1.84m', '128', '03']);
    expect(homeStats({ ...stats, monthRevenue: null, reorder: null }).map((c) => c.key)).toEqual(['in-production', 'customers']);
    expect(homeStats({ ...stats, inProduction: 0 }).find((c) => c.key === 'in-production')?.value).toBe('00');
  });

  it('words each card line, and drops a line it cannot back up', () => {
    const cards = homeStats(stats);
    expect(cards.map((c) => c.sub)).toEqual(['2 due this week', '↑ 12.8% vs last month', '8 new this month', 'Check your shelves']);
    expect(cards.map((c) => c.tone)).toEqual(['plain', 'good', 'plain', 'warn']);
    const bare = homeStats({ ...stats, dueThisWeek: null, trend: null, newCustomers: null, reorder: 0 });
    expect(bare.map((c) => c.sub)).toEqual([null, 'This month so far', null, 'All stocked up']);
    expect(homeStats({ ...stats, trend: { text: '↓ 5% vs last month', up: false } })[1]?.tone).toBe('warn');
  });

  it('builds the getting-started checklist from counts, skipping unknown ones', () => {
    const fresh = gettingStarted({ customers: 0, orders: 0, storefronts: 0 });
    expect(fresh.items.map((i) => [i.key, i.done])).toEqual([['storefront', false], ['customer', false], ['order', false]]);
    expect(fresh.items.map((i) => i.title)).toEqual(['Create your storefront', 'Add your first client', 'Create your first order']);
    expect(fresh.allDone).toBe(false);
    const partial = gettingStarted({ customers: 4, orders: 0, storefronts: null });
    expect(partial.items.map((i) => i.key)).toEqual(['customer', 'order']);
    expect(partial.items[0]?.done).toBe(true);
    expect(gettingStarted({ customers: 1, orders: 2, storefronts: 1 }).allDone).toBe(true);
    expect(gettingStarted({ customers: null, orders: null, storefronts: null })).toEqual({ items: [], allDone: false });
  });
});
