import { OrderForm } from '@/components/app/OrderForm';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { CustomerSummary, Paged } from '@/lib/customer-types';
import { getSession, serverGet } from '@/lib/session';
import type { Location, StaffMember } from '@/lib/staff-types';
import { todayIn } from '@/lib/orders';
import { can } from '@/lib/team';

export const metadata = { title: 'New order · Avzar' };
export const dynamic = 'force-dynamic';

export default async function NewOrderPage() {
  const me = (await getSession())!;
  if (!can(me, 'orders.manage') || !can(me, 'customers.view') || !can(me, 'staff.view')) return <NoAccess />;
  const [customers, locations, staff] = await Promise.all([
    serverGet<Paged<CustomerSummary>>('/api/customers?page=1&pageSize=100&status=Active&sort=name'),
    serverGet<Location[]>('/api/locations'),
    serverGet<StaffMember[]>('/api/staff'),
  ]);
  if (!customers.ok) return <LoadError status={customers.status} />;
  if (!locations.ok) return <LoadError status={locations.status} />;
  if (!staff.ok) return <LoadError status={staff.status} />;
  const allowedIds = me.isOwner || can(me, 'locations.all') ? null : new Set(staff.data.find((m) => m.userId === me.userId)?.locationIds ?? []);
  const visibleLocations = locations.data.filter((l) => l.isActive && (allowedIds === null || allowedIds.has(l.id)));
  return (
    <>
      <p className="ap-hint">Create a draft first. Review the server-calculated total, then issue a quotation when it is ready.</p>
      <OrderForm customers={customers.data.items.filter((c) => c.status === 'Active')} locations={visibleLocations} today={todayIn(me.timeZoneId)} />
    </>
  );
}
