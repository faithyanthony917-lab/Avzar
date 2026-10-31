import type { CurrentUser } from './auth-types';

export type NavGroup = 'workroom' | 'business' | 'tools';
export const NAV_GROUP_LABELS: Record<NavGroup, string> = { workroom: 'Workroom', business: 'Business', tools: 'Tools' };
/** Pages that have a tab of their own on phones. Everything else with a group lives under Extras. */
export const PRIMARY_NAV_HREFS = ['/dashboard', '/customers', '/orders'] as const;

export interface NavItem {
  href: string;
  label: string;
  /** Section on the Extras page and in the sidebar. Leave empty for the primary pages. */
  group?: NavGroup;
  /** One short line shown under the label on the Extras page. */
  blurb?: string;
  /** Visible when the user holds ANY of these permissions (owners always see it). Empty = everyone. */
  anyOf: string[];
  /** false = the page does not exist yet; hidden so the menu never leads to a 404. Flip as each slice ships. */
  ready: boolean;
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Home', anyOf: [], ready: true },
  { href: '/customers', label: 'Customers', anyOf: ['customers.view'], ready: true },
  { href: '/orders', label: 'Orders', anyOf: ['orders.view'], ready: true },
  { href: '/fittings', label: 'Fittings', group: 'workroom', blurb: 'Appointments and client fittings', anyOf: ['orders.view'], ready: true },
  { href: '/inquiries', label: 'Requests', group: 'workroom', blurb: 'Requests from your storefront', anyOf: ['inquiries.view'], ready: true },
  { href: '/tasks', label: 'Production', group: 'workroom', blurb: 'Tasks, workflow and team availability', anyOf: ['tasks.view', 'tasks.work'], ready: true },
  { href: '/tasks/schedule', label: 'Shop schedule', group: 'workroom', blurb: 'Planned work across the shop', anyOf: ['tasks.view'], ready: true },
  { href: '/tasks/requests', label: 'Worker requests', group: 'workroom', blurb: 'Requests from your workers', anyOf: ['tasks.manage'], ready: true },
  { href: '/workflows', label: 'Production templates', group: 'workroom', blurb: 'Templates for your production stages', anyOf: ['workflows.manage'], ready: true },
  { href: '/workers/schedule', label: 'Worker schedules', group: 'workroom', blurb: 'Who works when, and calendar links', anyOf: ['tasks.view'], ready: true },
  { href: '/finance', label: 'Finance', group: 'business', blurb: 'Invoices, payments and expenses', anyOf: ['invoices.view', 'payments.view', 'expenses.view'], ready: true },
  { href: '/inventory', label: 'Inventory', group: 'business', blurb: 'Materials and stock', anyOf: ['inventory.view', 'inventory.manage'], ready: true },
  { href: '/inventory/suppliers', label: 'Suppliers', group: 'business', blurb: 'Who you buy from', anyOf: ['inventory.view', 'inventory.manage'], ready: true },
  { href: '/inventory/purchase-orders', label: 'Purchase orders', group: 'business', blurb: 'Orders placed with suppliers', anyOf: ['inventory.view', 'inventory.manage'], ready: true },
  { href: '/inventory/ready-to-wear', label: 'Ready-to-wear stock', group: 'business', blurb: 'Ready-made stock for your shop', anyOf: ['designs.manage'], ready: true },
  { href: '/catalog', label: 'Design catalog', group: 'business', blurb: 'Designs, collections and categories', anyOf: ['designs.view'], ready: true },
  { href: '/ai-studio', label: 'AI studio', group: 'tools', blurb: 'Creative tools', anyOf: ['designs.manage', 'storefront.edit'], ready: true },
  { href: '/reports', label: 'Reports', group: 'business', blurb: 'Business reports', anyOf: ['reports.view'], ready: true },
  { href: '/storefront', label: 'Storefront', group: 'business', blurb: 'Your online shop', anyOf: ['storefront.view'], ready: true },
  { href: '/staff', label: 'Staff & roles', group: 'business', blurb: 'Staff, roles and locations', anyOf: ['staff.view'], ready: true },
  { href: '/audit', label: 'Audit log', group: 'tools', blurb: 'Who changed what', anyOf: ['audit.view'], ready: true },
  { href: '/settings', label: 'Settings', group: 'tools', blurb: 'Business details', anyOf: ['business.settings'], ready: true },
];

export function visibleNav(user: Pick<CurrentUser, 'isOwner' | 'permissions'>, items: NavItem[] = NAV): NavItem[] {
  return items.filter((i) => i.ready && (i.anyOf.length === 0 || user.isOwner || i.anyOf.some((p) => user.permissions.includes(p))));
}

export interface ExtraSection { group: NavGroup; label: string; items: Array<Pick<NavItem, 'href' | 'label' | 'blurb'>> }

/** The grouped (non-primary) pages a user may see, in a fixed section order. Empty sections are left out. */
export function extraSections(items: Array<Pick<NavItem, 'href' | 'label' | 'group' | 'blurb'>>): ExtraSection[] {
  return (Object.keys(NAV_GROUP_LABELS) as NavGroup[])
    .map((group) => ({
      group,
      label: NAV_GROUP_LABELS[group],
      items: items.filter((i) => i.group === group).map(({ href, label, blurb }) => ({ href, label, blurb })),
    }))
    .filter((s) => s.items.length > 0);
}
