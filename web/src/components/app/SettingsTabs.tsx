'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

// Tab order and icons follow the workshop design; Storefront analytics is not in the design, so it comes last.
const TABS: Array<{ href: string; label: string; icon: ReactNode; tab?: 'details' | 'brand' }> = [
  { href: '/settings', tab: 'details', label: 'Studio details', icon: <><path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5" /><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244" /><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05" /></> },
  { href: '/settings?tab=brand', tab: 'brand', label: 'Brand & hours', icon: <><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" /></> },
  { href: '/settings/billing', label: 'Billing', icon: <><rect width="20" height="14" x="2" y="5" rx="2" /><path d="M2 10h20" /></> },
  { href: '/account/security', label: 'Security', icon: <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></> },
  { href: '/account/data', label: 'Your data', icon: <><path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /></> },
  { href: '/settings/analytics', label: 'Storefront analytics', icon: <path d="M5 20V10M12 20V4M19 20v-7" /> },
];

/** `active` is only passed by /settings itself, which shows either Studio details or Brand & hours on the same route. */
export function SettingsTabs({ active = 'details' }: { active?: 'details' | 'brand' }) {
  const path = usePathname();
  return (
    <nav aria-label="Settings sections" className="ap-subnav">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={(t.tab ? path === '/settings' && active === t.tab : path === t.href) ? 'page' : undefined}>
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">{t.icon}</svg>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
