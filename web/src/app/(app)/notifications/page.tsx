import Link from 'next/link';
import { PageHead } from '@/components/app/PageHead';
import { getSession } from '@/lib/session';
import { NotificationsList } from '@/components/app/NotificationsList';

export const metadata = { title: 'Notifications · Avzar' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const me = (await getSession())!;
  return (
    <div className="ap-stack">
      <PageHead title="Notifications" intro="A considered inbox for the things that need your attention." zone={me.timeZoneId} />
      <NotificationsList />
      <section className="ap-panel ap-pref-card" aria-labelledby="pref-h">
        <div>
          <p className="ap-eyebrow">Your preferences</p>
          <h2 id="pref-h">Choose what finds you.</h2>
          <p className="ap-foot">Email and in-app notification preferences.</p>
        </div>
        <Link href="/settings/notifications" className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }}>Manage preferences</Link>
      </section>
    </div>
  );
}
