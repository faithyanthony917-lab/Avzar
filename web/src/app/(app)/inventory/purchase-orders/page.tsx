import { PageHead } from '@/components/app/PageHead';
import { NoAccess } from '@/components/app/Notices';
import { PurchaseOrderList } from '@/components/app/PurchaseOrderList';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Purchase orders · Avzar' };
export const dynamic = 'force-dynamic';

export default async function PurchaseOrdersPage() {
  const me = (await getSession())!;
  if (!can(me, 'inventory.view') && !can(me, 'inventory.manage')) return <NoAccess />;
  return <div className="ap-stack"><PageHead title="Purchase orders" intro="Stock you have ordered from suppliers, and what has arrived." zone={me.timeZoneId} /><PurchaseOrderList canManage={can(me, 'inventory.manage')} /></div>;
}
