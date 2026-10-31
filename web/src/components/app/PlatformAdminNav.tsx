const LINKS = [
  { href: '/platform-admin/businesses', label: 'Businesses' },
  { href: '/platform-admin/users', label: 'Find a user' },
  { href: '/platform-admin/audit', label: 'Audit log' },
  { href: '/platform-admin/health', label: 'Health' },
  { href: '/platform-admin/operations', label: 'Operations' },
  { href: '/platform-admin/plans', label: 'Plans' },
  { href: '/platform-admin/email-suppressions', label: 'Email suppressions' },
];

export function PlatformAdminNav({ current }: { current: string }) {
  return (
    <nav className="ap-row" aria-label="Platform administration">
      {LINKS.map((l) => <a key={l.href} className="ap-btn ap-btn-quiet" href={l.href} aria-current={l.href === current ? 'page' : undefined}>{l.label}</a>)}
    </nav>
  );
}
