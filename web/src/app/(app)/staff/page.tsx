import { LoadError, NoAccess } from '@/components/app/Notices';
import { TeamView } from '@/components/app/TeamView';
import { getSession, serverGet } from '@/lib/session';
import type { Location, Role, StaffMember } from '@/lib/staff-types';
import { can } from '@/lib/team';

export const metadata = { title: 'Team · Avzar' };
export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const me = (await getSession())!;
  if (!can(me, 'staff.view')) return <NoAccess />;
  const [staff, roles, locations] = await Promise.all([
    serverGet<StaffMember[]>('/api/staff'), serverGet<Role[]>('/api/roles'), serverGet<Location[]>('/api/locations'),
  ]);
  if (!staff.ok) return <LoadError status={staff.status} />;
  if (!roles.ok) return <LoadError status={roles.status} />;
  if (!locations.ok) return <LoadError status={locations.status} />;
  return <TeamView me={me} staff={staff.data} roles={roles.data} locations={locations.data} canManage={can(me, 'staff.manage')} />;
}
