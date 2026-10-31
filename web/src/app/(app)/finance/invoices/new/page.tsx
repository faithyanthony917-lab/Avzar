import { CreateInvoiceForm } from '@/components/app/CreateInvoiceForm';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { CustomerSummary, Paged } from '@/lib/customer-types';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'New invoice · Avzar' };
export const dynamic = 'force-dynamic';

export default async function NewInvoicePage() {
  const me = (await getSession())!;
  if (!can(me, 'invoices.manage') || !can(me, 'customers.view')) return <NoAccess />;
  const customers = await serverGet<Paged<CustomerSummary>>('/api/customers?page=1&pageSize=100&status=Active&sort=name');
  if (!customers.ok) return <LoadError status={customers.status} />;
  return <CreateInvoiceForm customers={customers.data.items.filter((c) => c.status === 'Active')} />;
}
