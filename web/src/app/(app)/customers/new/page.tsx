import { PageHead } from '@/components/app/PageHead';
import { CustomerForm } from '@/components/app/CustomerForm';
import { NoAccess } from '@/components/app/Notices';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'New customer · Avzar' };
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  const me = (await getSession())!;
  if (!can(me, 'customers.manage')) return <NoAccess />;
  return (
    <>
      <PageHead title="New customer" intro="Add a client to your book." zone={me.timeZoneId} />
      <CustomerForm />
    </>
  );
}
