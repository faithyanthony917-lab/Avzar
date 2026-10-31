import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/app/LoginForm';
import { getSession } from '@/lib/session';
import { safeNext } from '@/lib/redirect';

export const metadata = { title: 'Sign in · Avzar' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = safeNext((await searchParams).next);
  if (await getSession()) redirect(next);
  return <LoginForm next={next} />;
}
