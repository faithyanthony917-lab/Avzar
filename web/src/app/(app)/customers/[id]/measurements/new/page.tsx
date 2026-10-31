import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { MeasurementForm } from '@/components/app/MeasurementForm';
import type { Customer } from '@/lib/customer-types';
import type { MeasurementTemplate } from '@/lib/measurement-types';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'New measurement profile · Avzar' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewMeasurementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GUID.test(id)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'measurements.record')) return <NoAccess />;

  const [cust, tpls] = await Promise.all([
    serverGet<Customer>(`/api/customers/${id}`),
    serverGet<MeasurementTemplate[]>('/api/measurement-templates'), // active templates only by default
  ]);
  if (!cust.ok) { if (cust.status === 404) notFound(); return <LoadError status={cust.status} />; }
  if (!tpls.ok) return <LoadError status={tpls.status} />;

  const back = <p style={{ margin: '0 0 .5rem' }}><Link href={`/customers/${id}`}>← {cust.data.fullName}</Link></p>;
  // The API only records measurements for Active customers (customer_not_active otherwise).
  if (cust.data.status !== 'Active') {
    return <>{back}<h1>New measurement profile</h1><p className="ap-alert" role="status">Measurements can only be recorded for active customers.</p></>;
  }
  const templates = tpls.data.filter((t) => t.isActive && t.fields.length > 0);
  return (
    <>
      {back}
      <h1>New measurement profile</h1>
      {templates.length === 0
        ? <p className="ap-alert" role="status">There are no active measurement templates with fields yet. A template has to be set up before a profile can be recorded.</p>
        : <MeasurementForm mode="new" customerId={id} templates={templates} />}
    </>
  );
}
