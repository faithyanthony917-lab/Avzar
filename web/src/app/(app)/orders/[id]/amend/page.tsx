import { PageHead } from '@/components/app/PageHead';
import { notFound, redirect } from 'next/navigation';
import { OrderForm } from '@/components/app/OrderForm';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { Order } from '@/lib/order-types';
import type { Location, StaffMember } from '@/lib/staff-types';
import { getSession, serverGet } from '@/lib/session';
import { todayIn } from '@/lib/orders';
import { can } from '@/lib/team';

export const metadata = { title: 'Amend order · Avzar' };
export const dynamic = 'force-dynamic';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AmendOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GUID.test(id)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'orders.confirm') || !can(me, 'staff.view')) return <NoAccess />;
  const [order, locations, staff] = await Promise.all([serverGet<Order>(`/api/orders/${id}`), serverGet<Location[]>('/api/locations'), serverGet<StaffMember[]>('/api/staff')]);
  if (!order.ok) { if (order.status === 404) notFound(); return <LoadError status={order.status} />; }
  if (!['Confirmed', 'InProduction'].includes(order.data.status)) redirect(`/orders/${id}`);
  if (!locations.ok) return <LoadError status={locations.status} />;
  if (!staff.ok) return <LoadError status={staff.status} />;
  const allowedIds = me.isOwner || can(me, 'locations.all') ? null : new Set(staff.data.find((m) => m.userId === me.userId)?.locationIds ?? []);
  const visibleLocations = locations.data.filter((l) => l.isActive && (allowedIds === null || allowedIds.has(l.id)));
  return <><PageHead title={`Amend ${order.data.orderNumber}`} zone={me.timeZoneId} /><p className="ap-hint">The server validates production state, invoices, version and location access before saving. If work has started, the amendment is rejected without saving.</p><OrderForm order={order.data} amend canReplan={can(me, 'tasks.manage')} customers={[]} locations={visibleLocations} today={todayIn(me.timeZoneId)} /></>;
}
