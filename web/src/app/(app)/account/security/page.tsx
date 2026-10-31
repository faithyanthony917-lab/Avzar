import { PageHead } from '@/components/app/PageHead';
import Link from 'next/link';
import { AccountSecurity } from '@/components/app/AccountSecurity';
import { LoadError } from '@/components/app/Notices';
import type { DeviceSession, SecuritySummary } from '@/lib/account-security';
import { getSession, serverGet } from '@/lib/session';

export const metadata = { title: 'Account security · Avzar' };
export const dynamic = 'force-dynamic';

/** Signed-in only. Deliberately no business permission: every role can manage their own sign-in security (accountRoutes.js:54-96). */
export default async function AccountSecurityPage() {
  const me = (await getSession())!;
  const [security, sessions] = await Promise.all([
    serverGet<SecuritySummary>('/api/account/security'),
    serverGet<DeviceSession[]>('/api/account/sessions'),
  ]);
  if (!security.ok) return <LoadError status={security.status} />;
  if (!sessions.ok) return <LoadError status={sessions.status} />;
  return <>
    <p style={{ margin: '0 0 .5rem' }}><Link href="/account">← Profile</Link></p>
    <PageHead title="Account security" intro={`Signed in as ${me.fullName} · ${me.email}`} zone={me.timeZoneId} />
    <AccountSecurity initialSecurity={security.data} initialSessions={sessions.data} timeZoneId={me.timeZoneId} />
  </>;
}
