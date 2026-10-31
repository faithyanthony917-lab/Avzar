import { NoAccess } from '@/components/app/Notices';
import { PurchaseOrderDetail } from '@/components/app/PurchaseOrderDetail';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Purchase order · Avzar' };
export const dynamic = 'force-dynamic';

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const me = (await getSession())!;
  if (!can(me, 'inventory.view') && !can(me, 'inventory.manage')) return <NoAccess />;
  const { id } = await params;
  return <div className="ap-stack"><PurchaseOrderDetail id={id} canManage={can(me, 'inventory.manage')} /></div>;
}
