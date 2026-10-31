import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, CATEGORY_DEFAULTS, DEFAULT_QUIET_HOURS, clip, effectiveChannels, isCategory, localClock, quietHoursEnd } from '../../src/notifications/notificationCatalog.js';

const overnight = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 };
const daytime = { enabled: true, startMinute: 13 * 60, endMinute: 14 * 60 };

describe('notification catalog', () => {
  it('has a default for every category, with email on only for tasks and push never on by default', () => {
    assert.deepEqual(Object.keys(CATEGORY_DEFAULTS).sort(), [...CATEGORIES].sort());
    for (const category of CATEGORIES) {
      assert.equal(CATEGORY_DEFAULTS[category].inApp, true, category);
      assert.equal(CATEGORY_DEFAULTS[category].push, false, category);
      assert.equal(CATEGORY_DEFAULTS[category].email, category === 'tasks', category);
    }
  });

  it('recognises only known categories', () => {
    assert.equal(isCategory('orders'), true);
    for (const value of ['', 'Orders', 'admin', null, undefined, 7]) assert.equal(isCategory(value), false);
  });

  it('merges a stored row over the defaults and ignores missing columns', () => {
    assert.deepEqual(effectiveChannels('orders', undefined), { inApp: true, email: false, push: false });
    assert.deepEqual(effectiveChannels('orders', { InAppEnabled: false, EmailEnabled: true, PushEnabled: false }), { inApp: false, email: true, push: false });
    assert.deepEqual(effectiveChannels('tasks', { InAppEnabled: null, EmailEnabled: null, PushEnabled: null }), { inApp: true, email: true, push: false });
    assert.throws(() => effectiveChannels('nope', undefined), TypeError);
  });

  it('clips long text with an ellipsis and collapses whitespace', () => {
    assert.equal(clip('  a \n b  ', 10), 'a b');
    const out = clip('x'.repeat(500), 300);
    assert.equal(out.length, 300);
    assert.ok(out.endsWith('\u2026'));
    assert.equal(clip(null, 5), '');
  });

  it('reads the local clock in the business time zone and falls back to UTC for a bad zone', () => {
    const instant = new Date('2026-10-20T22:30:15Z');
    assert.deepEqual(localClock(instant, 'UTC'), { minuteOfDay: 22 * 60 + 30, second: 15 });
    assert.deepEqual(localClock(instant, 'Africa/Lagos'), { minuteOfDay: 23 * 60 + 30, second: 15 });
    assert.deepEqual(localClock(instant, 'Not/AZone'), { minuteOfDay: 22 * 60 + 30, second: 15 });
    assert.equal(localClock(new Date('2026-10-20T00:05:00Z'), 'UTC').minuteOfDay, 5);
  });

  it('returns null outside quiet hours, when disabled, or when the window is empty', () => {
    assert.equal(quietHoursEnd(new Date('2026-10-20T12:00:00Z'), overnight, 'UTC'), null);
    assert.equal(quietHoursEnd(new Date('2026-10-20T23:00:00Z'), { ...overnight, enabled: false }, 'UTC'), null);
    assert.equal(quietHoursEnd(new Date('2026-10-20T23:00:00Z'), { enabled: true, startMinute: 600, endMinute: 600 }, 'UTC'), null);
    assert.equal(quietHoursEnd(new Date('2026-10-20T07:00:00Z'), overnight, 'UTC'), null, 'the end minute itself is not quiet');
    assert.equal(DEFAULT_QUIET_HOURS.enabled, false);
  });

  it('ends an overnight window at the next 07:00 local, before and after midnight', () => {
    assert.equal(quietHoursEnd(new Date('2026-10-20T23:00:00Z'), overnight, 'UTC').toISOString(), '2026-10-21T07:00:00.000Z');
    assert.equal(quietHoursEnd(new Date('2026-10-21T02:10:30Z'), overnight, 'UTC').toISOString(), '2026-10-21T07:00:00.000Z');
    assert.equal(quietHoursEnd(new Date('2026-10-20T22:00:00Z'), overnight, 'UTC').toISOString(), '2026-10-21T07:00:00.000Z', 'the start minute is quiet');
  });

  it('applies the window in the business time zone, not UTC', () => {
    // 21:30 UTC is 22:30 in Lagos (UTC+1, no DST): quiet there, but not quiet in UTC.
    const instant = new Date('2026-10-20T21:30:00Z');
    assert.equal(quietHoursEnd(instant, overnight, 'UTC'), null);
    assert.equal(quietHoursEnd(instant, overnight, 'Africa/Lagos').toISOString(), '2026-10-21T06:00:00.000Z');
    // New York is UTC-4 in late October: 03:00 UTC is 23:00 local on the 19th.
    assert.equal(quietHoursEnd(new Date('2026-10-20T03:00:00Z'), overnight, 'America/New_York').toISOString(), '2026-10-20T11:00:00.000Z');
  });

  it('supports a same-day window', () => {
    assert.equal(quietHoursEnd(new Date('2026-10-20T13:15:00Z'), daytime, 'UTC').toISOString(), '2026-10-20T14:00:00.000Z');
    assert.equal(quietHoursEnd(new Date('2026-10-20T14:00:00Z'), daytime, 'UTC'), null);
    assert.equal(quietHoursEnd(new Date('2026-10-20T12:59:59Z'), daytime, 'UTC'), null);
  });
});
