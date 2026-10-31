import { PageHead } from '@/components/app/PageHead';
import { notFound, redirect } from 'next/navigation';
import { CustomerForm } from '@/components/app/CustomerForm';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { Customer } from '@/lib/customer-types';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Edit customer · Avzar' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GUID.test(id)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'customers.manage')) return <NoAccess />;
  const res = await serverGet<Customer>(`/api/customers/${id}`);
  if (!res.ok) { if (res.status === 404) notFound(); return <LoadError status={res.status} />; }
  if (res.data.status === 'Merged') redirect(`/customers/${id}`);
  return (
    <>
      <PageHead title={res.data.fullName} intro="Edit this customer's details." zone={me.timeZoneId} />
      <CustomerForm customer={res.data} />
    </>
  );
}
