import { redirect } from 'next/navigation';
import { RegisterForm } from '@/components/app/RegisterForm';
import { getSession } from '@/lib/session';

export const metadata = { title: 'Create your business · Avzar' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  if (await getSession()) redirect('/dashboard');
  return <RegisterForm />;
}
