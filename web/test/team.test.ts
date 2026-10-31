import { describe, expect, it } from 'vitest';
import { assignableRoles, can, groupPermissions, isOwnerRole, roleNames, sameSet, toggle } from '../src/lib/team';
import { visibleNav } from '../src/lib/nav';
import type { Role } from '../src/lib/staff-types';

const roles: Role[] = [
  { id: 'o', name: 'Owner', isSystem: true, permissions: [] },
  { id: 'm', name: 'Manager', isSystem: true, permissions: [] },
  { id: 'c', name: 'Owner', isSystem: false, permissions: [] }, // a custom role that merely shares the name
];

describe('owner role handling', () => {
  it('only the built-in Owner role is protected', () => {
    expect(isOwnerRole(roles[0]!)).toBe(true);
    expect(isOwnerRole(roles[1]!)).toBe(false);
    expect(isOwnerRole(roles[2]!)).toBe(false);
  });
  it('is never offered for assignment', () => expect(assignableRoles(roles).map((r) => r.id)).toEqual(['m', 'c']));
});

describe('selection helpers', () => {
  it('toggle adds once and removes', () => {
    expect(toggle(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a', false)).toEqual(['b']);
  });
  it('sameSet ignores order but not content', () => {
    expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameSet(['a', 'a'], ['a', 'b'])).toBe(false);
  });
  it('roleNames skips unknown ids', () => expect(roleNames(['m', 'zzz'], roles)).toEqual(['Manager']));
});

describe('groupPermissions', () => {
  const g = groupPermissions(['orders.view', 'customers.view', 'customers.manage', 'locations.all', 'orders.view']);
  it('groups by prefix, sorted, without duplicates', () => {
    expect(g.map((x) => x.label)).toEqual(['Customers', 'Locations', 'Orders']);
    expect(g[0]!.items.map((i) => i.permission)).toEqual(['customers.manage', 'customers.view']);
    expect(g[2]!.items).toHaveLength(1);
  });
  it('humanises item labels and attaches hints to sensitive ones', () => {
    expect(g[0]!.items[1]!.label).toBe('View');
    expect(g[1]!.items[0]!.hint).toContain('every location');
  });
  it('copes with a key without a dot', () => expect(groupPermissions(['weird'])[0]!.items[0]!.label).toBe('Weird'));
});

describe('can / nav for staff pages', () => {
  it('owners can do anything', () => expect(can({ isOwner: true, permissions: [] }, 'staff.manage')).toBe(true));
  it('others need the permission', () => {
    expect(can({ isOwner: false, permissions: ['staff.view'] }, 'staff.manage')).toBe(false);
    expect(can({ isOwner: false, permissions: ['staff.view'] }, 'staff.view')).toBe(true);
  });
  it('the real nav shows Staff & roles only with staff.view (or owner)', () => {
    expect(visibleNav({ isOwner: false, permissions: [] }).map((i) => i.label)).toEqual(['Home']);
    expect(visibleNav({ isOwner: false, permissions: ['staff.view'] }).map((i) => i.label)).toContain('Staff & roles');
    expect(visibleNav({ isOwner: true, permissions: [] }).map((i) => i.label)).toContain('Staff & roles');
  });
});
