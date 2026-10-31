import { LoadError, NoAccess } from '@/components/app/Notices';
import { RoleManager } from '@/components/app/RoleManager';
import { getSession, serverGet } from '@/lib/session';
import type { Role } from '@/lib/staff-types';
import { can } from '@/lib/team';

export const metadata = { title: 'Roles · Avzar' };
export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const me = (await getSession())!;
  if (!can(me, 'staff.view')) return <NoAccess />;
  const canEdit = can(me, 'roles.manage');
  const [roles, available] = await Promise.all([
    serverGet<Role[]>('/api/roles'),
    canEdit ? serverGet<string[]>('/api/roles/permissions') : Promise.resolve(null),
  ]);
  if (!roles.ok) return <LoadError status={roles.status} />;
  if (available && !available.ok) return <LoadError status={available.status} />;
  return <RoleManager roles={roles.data} available={available && available.ok ? available.data : null} />;
}
