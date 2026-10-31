import type { CurrentUser } from './auth-types';
import type { Role } from './staff-types';

export const OWNER_ROLE = 'Owner';

export const can = (user: Pick<CurrentUser, 'isOwner' | 'permissions'>, permission: string) =>
  user.isOwner || user.permissions.includes(permission);

/** The Owner role can be neither assigned nor edited (the API refuses both). */
export const isOwnerRole = (r: Pick<Role, 'isSystem' | 'name'>) => r.isSystem && r.name === OWNER_ROLE;
export const assignableRoles = (roles: Role[]) => roles.filter((r) => !isOwnerRole(r));

export function toggle(list: string[], value: string, on: boolean): string[] {
  const without = list.filter((x) => x !== value);
  return on ? [...without, value] : without;
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

export function roleNames(ids: string[], roles: Role[]): string[] {
  const byId = new Map(roles.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Plain-language notes for permissions that deserve a second look before they are granted. */
export const PERMISSION_HINTS: Record<string, string> = {
  'locations.all': 'Sees every location, not only the ones assigned to them.',
  'payments.verify': 'Confirms, rejects and reverses payments. The only way money counts.',
  'pricing.view': 'Sees costs and margins.',
  'audit.view': 'Reads the audit log.',
  'tasks.override': 'Overrides production workflow rules.',
  'customers.merge': 'Merges duplicate customers.',
  'invoices.manage': 'Drafts, issues and voids invoices and credit notes.',
  'storefront.publish': 'Publishes, unpublishes and rolls back the public site.',
  'roles.manage': 'Edits what every role can do.',
  'staff.manage': 'Invites, deactivates and changes staff access.',
};

export interface PermissionGroup { key: string; label: string; items: { permission: string; label: string; hint?: string }[] }

/** "customers.view" -> group Customers, item View. Groups and items are sorted so the layout is stable. */
export function groupPermissions(permissions: string[]): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>();
  for (const p of [...new Set(permissions)].sort()) {
    const dot = p.indexOf('.');
    const key = dot > 0 ? p.slice(0, dot) : p;
    const rest = dot > 0 ? p.slice(dot + 1) : p;
    let g = groups.get(key);
    if (!g) { g = { key, label: cap(key), items: [] }; groups.set(key, g); }
    g.items.push({ permission: p, label: cap(rest.replace(/[._]/g, ' ')), hint: PERMISSION_HINTS[p] });
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
