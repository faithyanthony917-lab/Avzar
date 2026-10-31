import { PageHead } from '@/components/app/PageHead';
import { NoAccess } from '@/components/app/Notices';
import { PurchaseOrderForm } from '@/components/app/PurchaseOrderForm';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'New purchase order · Avzar' };
export const dynamic = 'force-dynamic';

export default async function NewPurchaseOrderPage() {
  const me = (await getSession())!;
  if (!can(me, 'inventory.manage')) return <NoAccess />;
  return <div className="ap-stack"><PageHead title="New purchase order" intro="Order stock from a supplier. It is saved as a draft until you mark it as ordered." zone={me.timeZoneId} /><PurchaseOrderForm canLinkExpense={can(me, 'expenses.manage')} defaultCurrency={me.currencyCode} /></div>;
}
