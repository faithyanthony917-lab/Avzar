import Link from 'next/link';
import { OwnershipTransferConfirmation } from '@/components/app/OwnershipTransferConfirmation';
import { getSession } from '@/lib/session';

export const metadata = { title: 'Confirm ownership transfer · Avzar', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function OwnershipTransferConfirmationPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const value = (await searchParams).token;
  const token = typeof value === 'string' ? value : '';
  const session = await getSession();
  if (!session) {
    const next = `/ownership-transfer/confirm?token=${encodeURIComponent(token)}`;
    return <section className="ap-stack"><h1>Confirm business ownership transfer</h1><p>You must sign in as the current business owner before confirming this request.</p><Link className="ap-btn" href={`/login?next=${encodeURIComponent(next)}`}>Sign in to confirm</Link></section>;
  }
  return <OwnershipTransferConfirmation token={token} />;
}
