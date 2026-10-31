import { PageHead } from '@/components/app/PageHead';
import { PlatformAdminNav } from '@/components/app/PlatformAdminNav';
import { PlatformUserLookup } from '@/components/app/PlatformUserLookup';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import type { PlatformUser } from '@/lib/platformAdmin';

export const metadata = { title: 'Find a user · Platform · Avzar' };
export const dynamic = 'force-dynamic';

export default async function PlatformUsersPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const me = (await getSession())!;
  const email = ((await searchParams).email ?? '').trim();
  let user: PlatformUser | null = null;
  let message: string | null = null;
  if (email) {
    const res = await serverGet<PlatformUser>(`/api/platform-admin/users?email=${encodeURIComponent(email)}`);
    if (res.ok) user = res.data;
    else if (res.status === 404) message = 'No account has that email address.';
    else if (res.status === 400) message = 'Enter a full email address.';
    else return res.status === 401 || res.status === 403 ? <NoAccess /> : <LoadError status={res.status} />;
  }
  return (
    <div className="ap-stack">
      <PageHead title="Find a user" intro="Look up a staff account by email address to see which businesses it belongs to." zone={me.timeZoneId} />
      <PlatformAdminNav current="/platform-admin/users" />
      <PlatformUserLookup email={email} user={user} message={message} />
    </div>
  );
}
