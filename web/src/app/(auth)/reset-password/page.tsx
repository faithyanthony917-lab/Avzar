import Link from 'next/link';
import { ResetPasswordForm } from '@/components/app/ResetPasswordForm';
import { parseEmailLink } from '@/lib/email-links';

// The link carries a secret token: never send it onward in a Referer header.
export const metadata = { title: 'Choose a new password · Avzar', referrer: 'no-referrer' as const };
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ userId?: string | string[]; token?: string | string[] }> }) {
  const link = parseEmailLink(await searchParams);
  if (!link) {
    return <div className="ap-form">
      <h1>This link is not valid</h1>
      <p role="alert" style={{ margin: 0 }}>The reset link is incomplete. Open the link from your email again, or request a new one.</p>
      <Link className="ap-btn" href="/forgot-password" style={{ textDecoration: 'none', textAlign: 'center' }}>Request a new link</Link>
    </div>;
  }
  return <ResetPasswordForm userId={link.userId} token={link.token} />;
}
