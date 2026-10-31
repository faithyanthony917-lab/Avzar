'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { BusinessSwitcher } from './BusinessSwitcher';
import { SignOutButton } from './SignOutButton';
import { BrandLogo } from '@/components/BrandLogo';
import { NotificationBell } from './NotificationBell';
import { PRIMARY_NAV_HREFS, extraSections, type NavGroup } from '@/lib/nav';
import { initials } from '@/lib/people-view';

type Item = { href: string; label: string; group?: NavGroup };
type Props = { items: Item[]; businessName: string; businessId: string; fullName: string; email: string };

/** The longest matching menu entry is the current page, so /tasks/schedule does not also light up /tasks. */
function currentHref(path: string, items: Item[]): string | null {
  const hits = items.filter((i) => path === i.href || path.startsWith(`${i.href}/`));
  return hits.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

const on = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

function Icon({ children }: { children: ReactNode }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">{children}</svg>;
}
const ICONS: Record<string, ReactNode> = {
  home: <Icon><path d="M4 11l8-7 8 7M6 10v10h12V10" /></Icon>,
  customers: <Icon><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.2a3.2 3.2 0 010 6M18 14.8c1.8.7 3 2.4 3 5.2" /></Icon>,
  orders: <Icon><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 10h6M9 14h6" /></Icon>,
  extras: <Icon><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></Icon>,
  profile: <Icon><circle cx="12" cy="8.5" r="3.6" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></Icon>,
};

/**
 * Wide screens: a sidebar (primary pages, then Workroom / Business / Tools).
 * Phones: a slim top bar plus a bottom tab bar (Home, Customers, Orders, Extras, Profile). The old drawer is gone;
 * /extras lists every other page the user may open.
 */
export function AppNav({ items, businessName, businessId, fullName, email }: Props) {
  const path = usePathname();
  const current = currentHref(path, items);
  const primary = items.filter((i) => !i.group);
  const sections = extraSections(items);
  const grouped = items.filter((i) => i.group);

  const has = (href: string) => items.some((i) => i.href === href);
  const tabs: Array<{ href: string; label: string; icon: string; active: boolean }> = [
    { href: '/dashboard', label: 'Home', icon: 'home', active: on(path, '/dashboard') },
    ...(has('/customers') ? [{ href: '/customers', label: 'Customers', icon: 'customers', active: on(path, '/customers') }] : []),
    ...(has('/orders') ? [{ href: '/orders', label: 'Orders', icon: 'orders', active: on(path, '/orders') }] : []),
    ...(grouped.length ? [{ href: '/extras', label: 'Extras', icon: 'extras', active: on(path, '/extras') || (!PRIMARY_NAV_HREFS.some((h) => on(path, h)) && !on(path, '/account') && !on(path, '/notifications') && grouped.some((i) => on(path, i.href))) }] : []),
    { href: '/account', label: 'Profile', icon: 'profile', active: on(path, '/account') || on(path, '/notifications') },
  ];

  return (
    <>
      <header className="ap-topbar">
        <BrandLogo href="/dashboard" />
        <span className="ap-topbiz">{businessName}</span>
        <NotificationBell placement="mobile" />
        <Link href="/account" className="ap-topavatar" aria-label="Open profile">{initials(fullName)}</Link>
      </header>

      <aside id="ap-drawer" className="ap-side">
        <div>
          <div className="ap-side-brand-row">
            <BrandLogo href="/dashboard" className="ap-logo ap-logo-side" />
            <NotificationBell placement="desktop" />
          </div>
          <p className="ap-biz">{businessName}</p>
          <p className="ap-who">{fullName} · {email}</p>
          <BusinessSwitcher currentBusinessId={businessId} />
        </div>
        <nav aria-label="Main">
          <ul>
            {primary.map((i) => (
              <li key={i.href}>
                <Link href={i.href} aria-current={i.href === current ? 'page' : undefined}>{i.label}</Link>
              </li>
            ))}
          </ul>
          {sections.map((s) => (
            <div key={s.group}>
              <p className="ap-nav-group">{s.label}</p>
              <ul>
                {s.items.map((i) => (
                  <li key={i.href}>
                    <Link href={i.href} aria-current={i.href === current ? 'page' : undefined}>{i.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <Link href="/account/security" className="ap-helplink" aria-current={path.startsWith('/account/security') ? 'page' : undefined}>Account security</Link>
        <Link href="/help" className="ap-helplink">Help and support</Link>
        <SignOutButton />
      </aside>

      <nav className="ap-dock" aria-label="Primary">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} aria-current={t.active ? 'page' : undefined}>
            {ICONS[t.icon]}
            <span>{t.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
