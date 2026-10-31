import Link from 'next/link';
import { VerifyEmail } from '@/components/app/VerifyEmail';
import { parseEmailLink } from '@/lib/email-links';

export const metadata = { title: 'Confirm your email · Avzar', referrer: 'no-referrer' as const };
export const dynamic = 'force-dynamic';

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ userId?: string | string[]; token?: string | string[] }> }) {
  const link = parseEmailLink(await searchParams);
  if (!link) {
    return <div className="ap-form">
      <h1>This link is not valid</h1>
      <p role="alert" style={{ margin: 0 }}>The confirmation link is incomplete. Open the link from your email again, or sign in and resend it from Account security.</p>
      <Link className="ap-btn" href="/login" style={{ textDecoration: 'none', textAlign: 'center' }}>Go to sign in</Link>
    </div>;
  }
  return <VerifyEmail userId={link.userId} token={link.token} />;
}
