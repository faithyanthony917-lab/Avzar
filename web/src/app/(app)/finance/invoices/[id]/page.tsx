import Link from 'next/link';
import { InvoiceDetailManager } from '@/components/app/InvoiceDetailManager';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { Invoice } from '@/lib/finance-types';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Invoice · Avzar' };
export const dynamic = 'force-dynamic';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const me = (await getSession())!;
  if (!can(me, 'invoices.view')) return <NoAccess />;
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return <LoadError status={404} />;
  const invoice = await serverGet<Invoice>(`/api/invoices/${id}`);
  if (!invoice.ok) return <LoadError status={invoice.status} />;
  return <><p style={{ margin: '0 0 .75rem' }}><Link href="/finance">← Finance</Link></p><InvoiceDetailManager initialInvoice={invoice.data} permissions={{ manage: can(me, 'invoices.manage'), recordPayment: can(me, 'payments.record'), verifyPayment: can(me, 'payments.verify'), viewPayments: can(me, 'payments.view') }} /></>;
}
