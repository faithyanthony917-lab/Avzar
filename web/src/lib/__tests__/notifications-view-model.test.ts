import { describe, expect, it } from 'vitest';
import { minutesFromTime, notificationQuery, notificationTargetHref, timeFromMinutes, unreadBadge, type NotificationItem } from '../notifications-view-model';

describe('notification view model', () => {
  it('formats unread badges without a zero badge and caps large counts', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(-1)).toBeNull();
    expect(unreadBadge(4)).toBe('4');
    expect(unreadBadge(99)).toBe('99');
    expect(unreadBadge(100)).toBe('99+');
    expect(unreadBadge(12, true)).toBe('99+');
  });

  it('builds same-origin list query URLs for filters and cursor paging', () => {
    expect(notificationQuery()).toBe('/api/notifications');
    expect(notificationQuery({ unread: true, category: 'orders', cursor: 'page token', limit: 15 }))
      .toBe('/api/notifications?unread=true&category=orders&limit=15&cursor=page+token');
  });

  it('converts valid quiet-hour times to and from minutes after midnight', () => {
    expect(minutesFromTime('22:15')).toBe(1335);
    expect(minutesFromTime('07:00')).toBe(420);
    expect(minutesFromTime('24:00')).toBeNull();
    expect(minutesFromTime('7:00')).toBeNull();
    expect(timeFromMinutes(1335)).toBe('22:15');
    expect(timeFromMinutes(2000)).toBe('23:59');
  });

  it('maps known target kinds to existing pages and leaves unknown targets unlinked', () => {
    const item = (kind: string): NotificationItem => ({
      id: 'n', category: 'orders', eventType: 'order.confirmed', title: 'Order confirmed', body: '',
      target: { kind, id: 'one/two' }, createdAtUtc: '2026-10-20T12:00:00.000Z', readAtUtc: null, isRead: false,
    });
    expect(notificationTargetHref(item('task'))).toBe('/tasks/one%2Ftwo');
    expect(notificationTargetHref(item('order'))).toBe('/orders/one%2Ftwo');
    expect(notificationTargetHref(item('invoice'))).toBe('/finance/invoices/one%2Ftwo');
    expect(notificationTargetHref(item('inquiry'))).toBe('/inquiries');
    expect(notificationTargetHref(item('subscription'))).toBe('/settings/billing');
    expect(notificationTargetHref(item('unknown'))).toBeNull();
    expect(notificationTargetHref(item('appointment'))).toBe('/fittings');
    expect(notificationTargetHref(item('leave'))).toBe('/workers/schedule');
  });
});