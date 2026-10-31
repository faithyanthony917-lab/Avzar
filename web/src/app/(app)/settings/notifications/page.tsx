import Link from 'next/link';
import { PageHead } from '@/components/app/PageHead';
import { getSession } from '@/lib/session';
import { NotificationPreferencesEditor } from '@/components/app/NotificationPreferencesEditor';

export const metadata = { title: 'Notification preferences · Avzar' };
export const dynamic = 'force-dynamic';

export default async function NotificationPreferencesPage() {
  const me = (await getSession())!;
  return (
    <div className="ap-stack">
      <PageHead title="Notification preferences" intro="Choose what reaches you, and when." zone={me.timeZoneId}>
        <Link href="/notifications" className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Back to notifications</Link>
      </PageHead>
      <NotificationPreferencesEditor />
    </div>
  );
}
