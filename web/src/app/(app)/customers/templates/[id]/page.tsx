import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MeasurementTemplateForm } from '@/components/app/MeasurementTemplateForm';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { MeasurementTemplate } from '@/lib/measurement-types';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Edit template · Avzar' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GUID.test(id)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'measurements.templates')) return <NoAccess />;
  const res = await serverGet<MeasurementTemplate>(`/api/measurement-templates/${id}`);
  if (!res.ok) { if (res.status === 404) notFound(); return <LoadError status={res.status} />; }
  return (
    <>
      <p style={{ margin: '0 0 .5rem' }}><Link href="/customers?tab=templates">← My Templates</Link></p>
      <h1>{res.data.name}</h1>
      <MeasurementTemplateForm template={res.data} />
    </>
  );
}
