'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/staff', label: 'Team' },
  { href: '/staff/roles', label: 'Roles' },
  { href: '/staff/locations', label: 'Locations' },
];

export function StaffTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Staff sections" className="ap-tabs">
      {TABS.map((t) => <Link key={t.href} href={t.href} aria-current={path === t.href ? 'page' : undefined}>{t.label}</Link>)}
    </nav>
  );
}
