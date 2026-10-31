import { PageHead } from '@/components/app/PageHead';
import { ReadyToWearInventory } from '@/components/app/ReadyToWearInventory';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Ready-to-wear stock · Avzar' };
export const dynamic = 'force-dynamic';
type Design = { id: string; name: string; basePrice: number | null; currencyCode: string | null; visibility: string };
type Variant = { id: string; designId: string; productName: string; sku: string; size: string | null; colour: string | null; onHand: number; reserved: number; available: number; isActive: boolean; price: number | null; currencyCode: string | null };
export default async function ReadyToWearInventoryPage() {
  const me = await getSession();
  if (!me || !can(me, 'designs.view') || !can(me, 'designs.manage')) return <NoAccess />;
  const [designs, variants] = await Promise.all([
    serverGet<{ items: Design[] }>('/api/designs?kind=ReadyMade&page=1&pageSize=100'),
    serverGet<{ items: Variant[] }>('/api/ready-to-wear/variants'),
  ]);
  const failed = [designs, variants].find((result) => !result.ok);
  if (failed && !failed.ok) { if (failed.status === 401 || failed.status === 403) return <NoAccess />; return <LoadError status={failed.status} />; }
  if (!designs.ok || !variants.ok) return <LoadError status={502} />;
  return <div className="ap-stack"><PageHead title="Ready-to-wear stock" intro="Manage product variants and stock counts. Available stock excludes active reservations. Checkout remains disabled until a platform administrator enables it." zone={me.timeZoneId} /><ReadyToWearInventory designs={designs.data.items ?? []} variants={variants.data.items ?? []} /></div>;
}
