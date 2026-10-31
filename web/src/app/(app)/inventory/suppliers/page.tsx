import { PageHead } from '@/components/app/PageHead';
import { NoAccess } from '@/components/app/Notices';
import { SupplierManager } from '@/components/app/SupplierManager';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Suppliers · Avzar' };
export const dynamic = 'force-dynamic';

export default async function SuppliersPage() {
  const me = (await getSession())!;
  if (!can(me, 'inventory.view') && !can(me, 'inventory.manage')) return <NoAccess />;
  return <div className="ap-stack"><PageHead title="Suppliers" intro="The people and shops you buy fabric and supplies from." zone={me.timeZoneId} /><SupplierManager canManage={can(me, 'inventory.manage')} /></div>;
}
