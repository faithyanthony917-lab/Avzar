export const NOTIFICATION_CATEGORIES = [
  { id: 'tasks', label: 'Production tasks' },
  { id: 'schedule', label: 'Shop schedule' },
  { id: 'orders', label: 'Orders and quotations' },
  { id: 'inquiries', label: 'Storefront inquiries' },
  { id: 'finance', label: 'Payments and invoices' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'billing', label: 'Subscription billing' },
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['id'];

export type NotificationItem = {
  id: string;
  category: NotificationCategory;
  eventType: string;
  title: string;
  body: string;
  target: { kind: string; id: string | null } | null;
  createdAtUtc: string;
  readAtUtc: string | null;
  isRead: boolean;
};

export type NotificationPage = { items: NotificationItem[]; nextCursor: string | null };
export type NotificationUnreadCount = { count: number; capped: boolean };
export type NotificationPreferences = {
  categories: Array<{ category: NotificationCategory; inApp: boolean; email: boolean; push: boolean }>;
  quietHours: { enabled: boolean; startMinute: number; endMinute: number };
  pushAvailable: boolean;
};

export function unreadBadge(count: number, capped = false): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return capped || count > 99 ? '99+' : String(Math.trunc(count));
}

export function notificationQuery(options: { unread?: boolean; category?: NotificationCategory | ''; cursor?: string | null; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (options.unread) params.set('unread', 'true');
  if (options.category) params.set('category', options.category);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  return `/api/notifications${query ? `?${query}` : ''}`;
}

export function minutesFromTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function timeFromMinutes(value: number): string {
  const minutes = Math.max(0, Math.min(1439, Math.trunc(value)));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function notificationTargetHref(item: NotificationItem): string | null {
  if (!item.target?.id) return null;
  const id = encodeURIComponent(item.target.id);
  if (item.target.kind === 'task') return `/tasks/${id}`;
  if (item.target.kind === 'order' || item.target.kind === 'quotation') return `/orders/${id}`;
  if (item.target.kind === 'invoice') return `/finance/invoices/${id}`;
  if (item.target.kind === 'material') return '/inventory';
  if (item.target.kind === 'payment') return '/finance';
  if (item.target.kind === 'subscription') return '/settings/billing';
  if (item.target.kind === 'appointment') return '/fittings';
  if (item.target.kind === 'leave') return '/workers/schedule';
  if (item.target.kind === 'inquiry') return '/inquiries';
  return null;
}