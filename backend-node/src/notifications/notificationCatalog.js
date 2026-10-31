// Static facts about notifications: categories, per-category defaults, target kinds and quiet-hours arithmetic.
// Pure functions only (no database), so they are cheap to test.

export const CATEGORIES = Object.freeze(['tasks', 'schedule', 'orders', 'inquiries', 'finance', 'inventory', 'billing']);

export const TARGET_KINDS = Object.freeze(['task', 'order', 'invoice', 'inquiry', 'material', 'subscription', 'quotation', 'payment', 'appointment', 'leave']);

// Defaults apply when a person has no saved preference row for a category. In-app is on everywhere. Email stays on only for
// "tasks" because task emails are sent today; every other category starts with email off so nobody gets a surprise email.
// Push is opt-in and is not delivered until mobile push exists (roadmap item A3).
export const CATEGORY_DEFAULTS = Object.freeze({
  tasks: { inApp: true, email: true, push: false },
  schedule: { inApp: true, email: false, push: false },
  orders: { inApp: true, email: false, push: false },
  inquiries: { inApp: true, email: false, push: false },
  finance: { inApp: true, email: false, push: false },
  inventory: { inApp: true, email: false, push: false },
  billing: { inApp: true, email: false, push: false },
});

export const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: false, startMinute: 22 * 60, endMinute: 7 * 60 });

export const TITLE_MAX = 120;
export const BODY_MAX = 300;
export const DEDUPE_KEY_MAX = 200;

export function isCategory(value) {
  return typeof value === 'string' && CATEGORIES.includes(value);
}

/** Shortens text to `max` characters, ending in an ellipsis when something was cut. */
export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

/** Merges a stored preference row (or nothing) over the defaults for a category. */
export function effectiveChannels(category, row) {
  const base = CATEGORY_DEFAULTS[category];
  if (!base) throw new TypeError(`Unknown notification category: ${category}`);
  if (!row) return { ...base };
  return {
    inApp: row.InAppEnabled ?? base.inApp,
    email: row.EmailEnabled ?? base.email,
    push: row.PushEnabled ?? base.push,
  };
}

/** Local time of day in an IANA zone: minutes after midnight plus the seconds into that minute. Falls back to UTC for an unknown zone. */
export function localClock(instant, timeZoneId) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZoneId || 'UTC', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant);
  }
  const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { minuteOfDay: (value('hour') % 24) * 60 + value('minute'), second: value('second') };
}

/**
 * When do quiet hours end for someone whose window is [startMinute, endMinute) in `timeZoneId`?
 * Returns null when it is not currently quiet (or quiet hours are off or the window is empty), otherwise the instant the window ends.
 * A window that crosses midnight (start > end, such as 22:00 to 07:00) is supported. Across a daylight-saving change inside the
 * window the end can be off by an hour; that only shifts when an email is released, never whether it is.
 */
export function quietHoursEnd(instant, { enabled, startMinute, endMinute }, timeZoneId) {
  if (!enabled || startMinute === endMinute) return null;
  const { minuteOfDay, second } = localClock(instant, timeZoneId);
  const quiet = startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
  if (!quiet) return null;
  const minutesLeft = (endMinute - minuteOfDay + 1440) % 1440;
  return new Date(instant.getTime() + (minutesLeft * 60 - second) * 1000);
}
