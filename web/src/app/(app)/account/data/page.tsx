import Link from 'next/link';
import { AccountData } from '@/components/app/AccountData';
import { LoadError } from '@/components/app/Notices';
import { PageHead } from '@/components/app/PageHead';
import type { SecuritySummary } from '@/lib/account-security';
import { getSession, serverGet } from '@/lib/session';

export const metadata = { title: 'Your data · Avzar' };
export const dynamic = 'force-dynamic';

/** Signed-in only. Download your own account data or delete your account; no business permission applies (accountRoutes.js). */
export default async function AccountDataPage() {
  const me = (await getSession())!;
  const security = await serverGet<SecuritySummary>('/api/account/security');
  if (!security.ok) return <LoadError status={security.status} />;
  return <>
    <PageHead title="Your data" intro="Download a copy of your account data, or delete your account." zone={me.timeZoneId} back={<Link href="/account">← Profile</Link>} />
    <AccountData twoFactorEnabled={security.data.twoFactorEnabled} />
  </>;
}
