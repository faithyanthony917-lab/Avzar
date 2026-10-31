import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AppNav } from '@/components/app/AppNav';
import { Toaster } from '@/components/app/Toaster';
import { visibleNav } from '@/lib/nav';
import { getSession } from '@/lib/session';
import { appFont } from '../fonts';
import '../app.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect('/login');
  const items = visibleNav(user).map(({ href, label, group }) => ({ href, label, group }));
  return (
    <div className={`ap ap-shell ${appFont.variable}`}>
      <AppNav items={items} businessName={user.businessName} businessId={user.businessId} fullName={user.fullName} email={user.email} />
      <main className="ap-main">{children}</main>
      <Toaster />
    </div>
  );
}
