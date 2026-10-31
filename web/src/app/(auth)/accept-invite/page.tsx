import Link from 'next/link';
import { AcceptInviteForm } from '@/components/app/AcceptInviteForm';
import { getSession } from '@/lib/session';

export const metadata = { title: 'Join your team · Avzar' };
export const dynamic = 'force-dynamic';

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const raw = (await searchParams).token;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!token || token.length > 512) {
    return (
      <div className="ap-form">
        <h1>Invitation link incomplete</h1>
        <p>This link is missing its invitation code. Open the link from the invitation email again, or ask the owner to send a new one.</p>
        <p className="ap-foot"><Link href="/login">Go to sign in</Link></p>
      </div>
    );
  }
  const user = await getSession();
  return <AcceptInviteForm token={token} signedInAs={user?.email ?? null} />;
}
