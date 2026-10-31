import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { MeasurementForm } from '@/components/app/MeasurementForm';
import type { Customer } from '@/lib/customer-types';
import type { MeasurementSet, MeasurementTemplate } from '@/lib/measurement-types';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'New revision · Avzar' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReviseMeasurementPage({ params }: { params: Promise<{ id: string; setId: string }> }) {
  const { id, setId } = await params;
  if (!GUID.test(id) || !GUID.test(setId)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'measurements.record')) return <NoAccess />;

  const [cust, sets] = await Promise.all([
    serverGet<Customer>(`/api/customers/${id}`),
    serverGet<MeasurementSet[]>(`/api/customers/${id}/measurements`),
  ]);
  if (!cust.ok) { if (cust.status === 404) notFound(); return <LoadError status={cust.status} />; }
  if (!sets.ok) return <LoadError status={sets.status} />;
  const set = sets.data.find((s) => s.id === setId);
  if (!set) notFound(); // also guards against a profile that belongs to another customer
  const tpl = await serverGet<MeasurementTemplate>(`/api/measurement-templates/${set.templateId}`);
  if (!tpl.ok) return <LoadError status={tpl.status} />;

  const back = <p style={{ margin: '0 0 .5rem' }}><Link href={`/customers/${id}/measurements/${setId}`}>← {set.label}</Link></p>;
  if (cust.data.status !== 'Active') {
    return <>{back}<h1>New revision</h1><p className="ap-alert" role="status">Measurements can only be revised for active customers.</p></>;
  }
  return (
    <>
      {back}
      <h1>New revision of {set.label}</h1>
      <p className="ap-hint">Current revision: {set.currentRevision}</p>
      <MeasurementForm mode="revise" customerId={id} set={set} template={tpl.data} />
    </>
  );
}
