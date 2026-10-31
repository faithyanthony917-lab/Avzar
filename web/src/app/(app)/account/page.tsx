import Link from 'next/link';
import { BusinessSwitcher } from '@/components/app/BusinessSwitcher';
import { NavGlyph } from '@/components/app/NavGlyph';
import { SignOutButton } from '@/components/app/SignOutButton';
import { PageHead } from '@/components/app/PageHead';
import { initials } from '@/lib/people-view';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Profile · Avzar' };
export const dynamic = 'force-dynamic';

type Row = { href: string; label: string };

function Rows({ rows }: { rows: Row[] }) {
  return <>{rows.map((i) => <li key={i.href}><Link href={i.href}><span className="ap-menu-main"><NavGlyph href={i.href} /><strong>{i.label}</strong></span></Link></li>)}</>;
}

/** The phone home for account links. Signed-in only; each link keeps its own permission rule. */
export default async function ProfilePage() {
  const me = (await getSession())!;
  const workspace: Row[] = [
    can(me, 'business.settings') && { href: '/settings', label: 'Studio settings' },
    can(me, 'staff.view') && { href: '/staff', label: 'Team & permissions' },
    can(me, 'business.settings') && { href: '/settings/billing', label: 'Plan & billing' },
    { href: '/account/security', label: 'Security & sessions' },
  ].filter((x): x is Row => !!x);
  const account: Row[] = [
    { href: '/notifications', label: 'Notifications' },
    { href: '/account/data', label: 'Your data' },
    { href: '/help', label: 'Help and support' },
  ];
  return (
    <div className="ap-stack">
      <PageHead title="Profile" intro="Your workshop, thoughtfully organized." zone={me.timeZoneId} />
      <section className="ap-panel ap-profile-head">
        <span className="ap-avatar" aria-hidden="true">{initials(me.fullName)}</span>
        <div className="ap-grow">
          <strong>{me.fullName}</strong>
          <p className="ap-foot" style={{ margin: 0 }}>{me.isOwner ? 'Studio owner' : 'Staff'} · {me.businessName}</p>
          <p className="ap-foot" style={{ margin: 0, overflowWrap: 'anywhere' }}>{me.email}</p>
        </div>
        <Link href="/account/profile" className="ap-soon" style={{ textDecoration: 'none', flex: 'none', alignSelf: 'flex-start' }}>Edit</Link>
      </section>
      <BusinessSwitcher currentBusinessId={me.businessId} />
      <section className="ap-xgroup" aria-labelledby="p-ws">
        <h2 id="p-ws" className="ap-nav-group">Your workspace</h2>
        <ul className="ap-plain ap-menu"><Rows rows={workspace} /></ul>
      </section>
      <section className="ap-xgroup" aria-labelledby="p-acc">
        <h2 id="p-acc" className="ap-nav-group">Help &amp; account</h2>
        <ul className="ap-plain ap-menu"><Rows rows={account} /><li><SignOutButton row /></li></ul>
      </section>
    </div>
  );
}
