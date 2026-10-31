import { LoadError, NoAccess } from '@/components/app/Notices';
import { LocationManager } from '@/components/app/LocationManager';
import { getSession, serverGet } from '@/lib/session';
import type { Location } from '@/lib/staff-types';
import { can } from '@/lib/team';

export const metadata = { title: 'Locations · Avzar' };
export const dynamic = 'force-dynamic';

export default async function LocationsPage() {
  const me = (await getSession())!;
  if (!can(me, 'staff.view')) return <NoAccess />;
  const locations = await serverGet<Location[]>('/api/locations');
  if (!locations.ok) return <LoadError status={locations.status} />;
  return <LocationManager locations={locations.data} canManage={can(me, 'locations.manage')} />;
}
