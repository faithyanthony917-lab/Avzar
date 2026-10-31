import Link from 'next/link';
import { MeasurementTemplateForm } from '@/components/app/MeasurementTemplateForm';
import { NoAccess } from '@/components/app/Notices';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'New template · Avzar' };
export const dynamic = 'force-dynamic';

export default async function NewTemplatePage() {
  const me = (await getSession())!;
  if (!can(me, 'measurements.templates')) return <NoAccess />;
  return (
    <>
      <p style={{ margin: '0 0 .5rem' }}><Link href="/customers?tab=templates">← My Templates</Link></p>
      <h1>New template</h1>
      <MeasurementTemplateForm />
    </>
  );
}
