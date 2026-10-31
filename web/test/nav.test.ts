import { describe, expect, it } from 'vitest';
import { visibleNav, type NavItem } from '../src/lib/nav';
import { safeNext } from '../src/lib/redirect';
import { defaultCurrency } from '../src/lib/locale';

const items: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', anyOf: [], ready: true },
  { href: '/customers', label: 'Customers', anyOf: ['customers.view'], ready: true },
  { href: '/finance', label: 'Finance', anyOf: ['invoices.view', 'payments.view'], ready: true },
  { href: '/soon', label: 'Soon', anyOf: [], ready: false },
];
const labels = (u: { isOwner: boolean; permissions: string[] }) => visibleNav(u, items).map((i) => i.label);

describe('visibleNav', () => {
  it('shows everyone the dashboard only', () => expect(labels({ isOwner: false, permissions: [] })).toEqual(['Dashboard']));
  it('shows items the user holds a permission for', () => expect(labels({ isOwner: false, permissions: ['payments.view'] })).toEqual(['Dashboard', 'Finance']));
  it('shows an owner everything that is built', () => expect(labels({ isOwner: true, permissions: [] })).toEqual(['Dashboard', 'Customers', 'Finance']));
  it('hides pages that do not exist yet, even from the owner', () => expect(labels({ isOwner: true, permissions: [] })).not.toContain('Soon'));
});

describe('safeNext: no open redirects', () => {
  it.each([['/dashboard'], ['/accept-invite?token=abc'], ['/a/b?c=d#e']])('keeps %s', (v) => expect(safeNext(v)).toBe(v));
  it.each([['//evil.com'], ['https://evil.com'], ['javascript:alert(1)'], ['/\\evil.com'], ['evil'], [''], ['/a\nb']])('refuses %j', (v) => expect(safeNext(v)).toBe('/dashboard'));
  it('handles missing and repeated params', () => {
    expect(safeNext(undefined)).toBe('/dashboard');
    expect(safeNext(['/orders', '//evil.com'])).toBe('/orders');
  });
});

describe('defaultCurrency', () => {
  it('maps known zones', () => expect(defaultCurrency('Africa/Lagos')).toBe('NGN'));
  it('falls back to EUR in Europe and USD elsewhere', () => {
    expect(defaultCurrency('Europe/Paris')).toBe('EUR');
    expect(defaultCurrency('Pacific/Auckland')).toBe('USD');
  });
});

describe('production schedule navigation', () => {
  it('shows the shop schedule to users with task-view permission', () => {
    expect(visibleNav({ isOwner: false, permissions: ['tasks.view'] }).map((i) => i.href)).toContain('/tasks/schedule');
  });
  it('does not show the shop schedule to worker-only users', () => {
    expect(visibleNav({ isOwner: false, permissions: ['tasks.work'] }).map((i) => i.href)).not.toContain('/tasks/schedule');
  });
  it('shows ready-to-wear stock only to users who can manage designs', () => {
    expect(visibleNav({ isOwner: false, permissions: ['designs.manage'] }).map((i) => i.href)).toContain('/inventory/ready-to-wear');
    expect(visibleNav({ isOwner: false, permissions: ['inventory.view'] }).map((i) => i.href)).not.toContain('/inventory/ready-to-wear');
  });
});

describe('requests navigation', () => {
  it('shows the requests page to users who can view inquiries, and not to others', () => {
    expect(visibleNav({ isOwner: false, permissions: ['inquiries.view'] }).map((i) => i.href)).toContain('/inquiries');
    expect(visibleNav({ isOwner: false, permissions: ['orders.view'] }).map((i) => i.href)).not.toContain('/inquiries');
  });
});
