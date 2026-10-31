import Link from 'next/link';
import { NAV_GROUP_LABELS, extraSections, visibleNav, type ExtraSection } from '@/lib/nav';
import { NavGlyph } from '@/components/app/NavGlyph';
import { PageHead } from '@/components/app/PageHead';
import { getSession, serverGet } from '@/lib/session';

export const metadata = { title: 'Extras · Avzar' };
export const dynamic = 'force-dynamic';

type Row = ExtraSection['items'][number];
const LEAD: Row[] = [
  { href: '/dashboard', label: 'Overview', blurb: 'Studio tools and details' },
  { href: '/customers', label: 'Customers', blurb: 'Studio tools and details' },
  { href: '/orders', label: 'Orders', blurb: 'Studio tools and details' },
];
const PLATFORM: Row = { href: '/platform-admin/operations', label: 'Platform', blurb: 'Operations for platform administrators' };
const NOTIFICATIONS: Row = { href: '/notifications', label: 'Notifications', blurb: 'Messages that need your attention' };

/** Every page, grouped as in the workshop design. Built from the same permission-filtered menu as the sidebar. */
export default async function ExtrasPage() {
  const me = (await getSession())!;
  const visible = visibleNav(me);
  // The session has no platform-admin flag, so ask the API: only platform administrators get a Platform row.
  const isPlatformAdmin = (await serverGet('/api/platform-admin/feature-flags')).ok;
  const base = extraSections(visible);
  const group = (g: ExtraSection['group']) => base.find((s) => s.group === g)?.items ?? [];
  const lead = LEAD.filter((r) => visible.some((i) => i.href === r.href));
  const all: ExtraSection[] = [
    { group: 'workroom', label: NAV_GROUP_LABELS.workroom, items: [...lead, ...group('workroom')] },
    { group: 'business', label: NAV_GROUP_LABELS.business, items: [...group('business'), NOTIFICATIONS] },
    { group: 'tools', label: NAV_GROUP_LABELS.tools, items: [...group('tools'), ...(isPlatformAdmin ? [PLATFORM] : [])] },
  ];
  const sections = all.filter((s) => s.items.length > 0);
  return (
    <div className="ap-stack">
      <PageHead title="Extras" intro="Your workshop, thoughtfully organized." zone={me.timeZoneId} />
      <div className="ap-xintro">
        <p className="ap-eyebrow">More for your studio</p>
        <h2>All the other good things.</h2>
        <p className="ap-foot">Workroom, money, materials and the tools around them.</p>
      </div>
      {sections.map((s) => (
        <section key={s.group} className="ap-xgroup" aria-labelledby={`x-${s.group}`}>
          <h2 id={`x-${s.group}`} className="ap-nav-group">{s.label}</h2>
          <ul className="ap-xgrid">
            {s.items.map((i) => (
              <li key={i.href}>
                <Link href={i.href} className="ap-xcard"><NavGlyph href={i.href} /><span className="ap-xtext"><strong>{i.label}</strong>{i.blurb && <span>{i.blurb}</span>}</span></Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
