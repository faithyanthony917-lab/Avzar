// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../support/dom';
import { PlatformAdminNav } from '@/components/app/PlatformAdminNav';
import { PlatformAuditList } from '@/components/app/PlatformAuditList';
import { PlatformBusinessDetailView } from '@/components/app/PlatformBusinessDetailView';
import { PlatformBusinessList } from '@/components/app/PlatformBusinessList';
import { PlatformHealthReport } from '@/components/app/PlatformHealthReport';
import { PlatformUserLookup } from '@/components/app/PlatformUserLookup';
import { bytes, uptime, when } from '@/lib/platformAdmin';
import type { PlatformBusiness, PlatformBusinessDetail, PlatformHealth, PlatformUser } from '@/lib/platformAdmin';

const biz = (n: number, over: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  id: `b${n}`, name: `Shop ${n}`, contactEmail: n === 1 ? 'one@example.test' : null, currencyCode: 'NGN', timeZoneId: 'UTC', isActive: true, createdAtUtc: '2026-10-20T08:30:00Z', ...over,
});

describe('display helpers', () => {
  it('formats times in fixed UTC, sizes and uptime', () => {
    expect(when('2026-10-31T09:05:00Z')).toBe('2026-10-31 09:05 UTC');
    expect(when(null)).toBe('—');
    expect(when('garbage')).toBe('—');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
    expect(uptime(59)).toBe('0m');
    expect(uptime(3 * 3600 + 120)).toBe('3h 2m');
    expect(uptime(2 * 86400 + 3600)).toBe('2d 1h');
  });
});

describe('PlatformAdminNav', () => {
  it('links every platform page and marks the current one', () => {
    render(<PlatformAdminNav current="/platform-admin/health" />);
    expect(screen.getByRole('link', { name: 'Health' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Businesses' }).getAttribute('aria-current')).toBeNull();
    for (const name of ['Businesses', 'Find a user', 'Audit log', 'Health', 'Operations', 'Plans', 'Email suppressions']) expect(screen.getByRole('link', { name })).toBeTruthy();
  });
});

describe('PlatformBusinessList', () => {
  it('lists businesses with a link to each detail page and an older-page link that keeps the search', () => {
    render(<PlatformBusinessList page={{ items: [biz(1), biz(2, { isActive: false })], next: 'CUR' }} q="shop" />);
    expect(screen.getByRole('link', { name: 'Shop 1' }).getAttribute('href')).toBe('/platform-admin/businesses/b1');
    expect(screen.getByText('one@example.test')).toBeTruthy();
    expect(screen.getByText('Inactive')).toBeTruthy();
    const older = screen.getByRole('link', { name: 'Older businesses' }).getAttribute('href')!;
    expect(older).toContain('q=shop');
    expect(older).toContain('before=CUR');
    expect((screen.getByLabelText(/Name or contact email/) as HTMLInputElement).defaultValue).toBe('shop');
  });

  it('says so when there are no businesses, and when a search finds none', () => {
    const { rerender } = render(<PlatformBusinessList page={{ items: [], next: null }} q="" />);
    expect(screen.getByText('There are no businesses yet.')).toBeTruthy();
    rerender(<PlatformBusinessList page={{ items: [], next: null }} q="zzz" />);
    expect(screen.getByText('No business matches that search.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Older businesses' })).toBeNull();
  });
});

describe('PlatformBusinessDetailView', () => {
  const detail: PlatformBusinessDetail = {
    ...biz(1), updatedAtUtc: null, owner: { email: 'owner@example.test', fullName: 'Ada Owner' },
    plan: { code: 'starter', name: 'Starter', status: 'Active', currentPeriodEndUtc: '2026-11-30T00:00:00Z' },
    usage: { activeStaff: 3, locations: 2, customers: 40, orders: 12, ordersLast30Days: 5, invoices: 9, storageBytes: 2048 },
  };
  it('shows owner, plan and counts, and says customer details are never shown', () => {
    render(<PlatformBusinessDetailView business={detail} />);
    expect(screen.getByText('Ada Owner (owner@example.test)')).toBeTruthy();
    expect(screen.getByText(/Starter \(Active, period ends 2026-11-30 00:00 UTC\)/)).toBeTruthy();
    const customers = screen.getByRole('row', { name: /Customers/ });
    expect(within(customers).getByText('40')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText(/never shown to platform administrators/)).toBeTruthy();
  });
  it('copes with no owner and no subscription', () => {
    render(<PlatformBusinessDetailView business={{ ...detail, owner: null, plan: null }} />);
    expect(screen.getByText('No subscription')).toBeTruthy();
  });
});

describe('PlatformUserLookup', () => {
  const user: PlatformUser = {
    id: 'u1', email: 'ada@example.test', fullName: 'Ada', emailConfirmed: true, twoFactorEnabled: true, lockedUntilUtc: '2026-10-31T12:00:00Z', failedSignIns: 1, createdAtUtc: '2026-09-01T00:00:00Z',
    memberships: [
      { id: 'm1', businessId: 'b1', businessName: 'Shop 1', businessActive: true, isOwner: true, active: true, displayName: 'Ada' },
      { id: 'm2', businessId: 'b2', businessName: 'Shop 2', businessActive: false, isOwner: false, active: false, displayName: 'Ada' },
    ],
  };
  it('shows the account and every business it belongs to', () => {
    render(<PlatformUserLookup email="ada@example.test" user={user} message={null} />);
    expect(screen.getByText(/ada@example.test \(confirmed\)/)).toBeTruthy();
    expect(screen.getByText(/Locked until 2026-10-31 12:00 UTC \(1 failed attempt on record\)/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Shop 1' }).getAttribute('href')).toBe('/platform-admin/businesses/b1');
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText('Deactivated')).toBeTruthy();
    expect(screen.getByRole('row', { name: /Shop 2/ }).textContent).toContain('(inactive)');
  });
  it('shows a not-found message and an empty form value, and notes the lookup is audited', () => {
    render(<PlatformUserLookup email="ghost@example.test" user={null} message="No account has that email address." />);
    expect(screen.getByRole('status').textContent).toBe('No account has that email address.');
    expect(screen.getByText(/without the address searched for/)).toBeTruthy();
    expect(screen.queryByLabelText('Account')).toBeNull();
  });
});

describe('PlatformAuditList', () => {
  const entry = { id: 'e1', actorEmail: 'ops@example.test', action: 'platform.business.viewed', entityType: 'Business', entityId: 'b1', details: {}, createdAtUtc: '2026-10-31T10:00:00Z' };
  const none = { action: '', actor: '', from: '', to: '' };
  it('lists entries and keeps the filters in the older-entries link', () => {
    render(<PlatformAuditList page={{ items: [entry], next: 'CUR' }} filters={{ ...none, action: 'platform.business.viewed', from: '2026-10-01' }} />);
    expect(screen.getByText('platform.business.viewed', { selector: 'td' })).toBeTruthy();
    expect(screen.getByText('Business b1')).toBeTruthy();
    const href = screen.getByRole('link', { name: 'Older entries' }).getAttribute('href')!;
    expect(href).toContain('action=platform.business.viewed');
    expect(href).toContain('from=2026-10-01');
    expect(href).toContain('before=CUR');
  });
  it('distinguishes an empty log from a filter with no matches', () => {
    const { rerender } = render(<PlatformAuditList page={{ items: [], next: null }} filters={none} />);
    expect(screen.getByText('The audit log is empty.')).toBeTruthy();
    rerender(<PlatformAuditList page={{ items: [], next: null }} filters={{ ...none, actor: 'x' }} />);
    expect(screen.getByText('No entries match these filters.')).toBeTruthy();
  });
});

describe('PlatformHealthReport', () => {
  const report: PlatformHealth = {
    checkedAtUtc: '2026-10-31T10:00:00Z',
    process: { nodeVersion: 'v22.1.0', uptimeSeconds: 7200, environment: 'production', emailProvider: 'resend', storageProvider: 's3' },
    database: { ok: true, pingMs: 1.4 }, migrations: { applied: 43, latest: '0043_platform_admin_read.sql' },
    queues: [{ kind: 'notification', statuses: { Failed: 2, Sent: 9 } }, { kind: 'push', statuses: {} }],
    configuration: [{ key: 'paystack', label: 'Paystack (billing and online payments)', set: true }, { key: 'meta_webhook', label: 'Meta WhatsApp webhook', set: false }],
  };
  it('shows the database, migrations, queues and which settings are present', () => {
    render(<PlatformHealthReport report={report} />);
    expect(screen.getByText('Reachable (1.4 ms)')).toBeTruthy();
    expect(screen.getByText('43 applied, latest 0043_platform_admin_read.sql')).toBeTruthy();
    expect(screen.getByText('Failed 2, Sent 9')).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /Paystack/ })).getByText('Set')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /Meta WhatsApp webhook/ })).getByText('Not set')).toBeTruthy();
  });
  it('reports an unreachable database and unreadable parts without crashing', () => {
    render(<PlatformHealthReport report={{ ...report, database: { ok: false, pingMs: null }, migrations: null, queues: null }} />);
    expect(screen.getByText('Not reachable')).toBeTruthy();
    expect(screen.getByText('Not readable by the API role')).toBeTruthy();
    expect(screen.getByText('Queue depth could not be read.')).toBeTruthy();
  });
});
