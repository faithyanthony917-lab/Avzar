// Step-12a: pure calculations behind the manager workload, calendar and "needs attention" views.
// No database and no imports, so every rule here is covered by unit tests that need nothing running.
// Times in, times out: instants are Date objects, business-local days are 'YYYY-MM-DD' strings, and the business
// time zone is an IANA name. Day boundaries follow that zone, including days that are 23 or 25 hours long.

export const LOAD_STATUSES = Object.freeze(['Scheduled', 'InProgress', 'Paused']);
export const NEAR_RATIO = 0.9;

const MINUTE = 60_000;

export function localDate(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function weekdayOf(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function timeMinutes(value) {
  const [hour, minute, second = 0] = String(value).split(':').map(Number);
  return hour * 60 + minute + second / 60;
}

function toUtc(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let result = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(result)).map(({ type, value }) => [type, value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const adjustment = target - represented;
    result += adjustment;
    if (adjustment === 0) return new Date(result);
  }
  throw new RangeError(`Local time ${date} ${time} does not exist in ${timeZone}.`);
}

/** Like toUtc, but a local time that falls in a spring-forward gap moves on by an hour instead of throwing. */
export function localToUtc(date, time, timeZone) {
  try {
    return toUtc(date, time, timeZone);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const [hour, minute, second = '00'] = time.split(':');
    const later = `${String((Number(hour) + 1) % 24).padStart(2, '0')}:${minute}:${second}`;
    return toUtc(date, later, timeZone);
  }
}

export function dayRangeUtc(date, timeZone) {
  return { startUtc: localToUtc(date, '00:00', timeZone), endUtc: localToUtc(addDays(date, 1), '00:00', timeZone) };
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return end > start ? Math.ceil((end - start) / MINUTE) : 0;
}

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(aEnd) > new Date(bStart);
}

/** Merge overlapping intervals so overlapping leave records are never counted twice. */
function mergeIntervals(intervals) {
  const sorted = intervals.map((i) => ({ start: new Date(i.startUtc), end: new Date(i.endUtc) }))
    .filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) { if (item.end > last.end) last.end = item.end; } else merged.push({ ...item });
  }
  return merged;
}

/**
 * The working window of one worker on one business-local day, and the minutes it can hold.
 * Rules (they mirror the planner in productionSchedulePlanner.js):
 *  - closed shop day or holiday: no window;
 *  - a worker with any availability row follows it: a missing or unavailable weekday means no window, otherwise the
 *    window is the overlap of the shop hours and the worker hours, and capacity is the smaller of the configured
 *    capacity and the window length;
 *  - a worker with no availability rows has no daily cap in the planner, so capacity is the shop's open minutes;
 *  - approved leave inside the window reduces the capacity minute for minute (never below zero).
 */
export function workerDayCapacity({ date, timeZone, weeklyHours, holidays, availabilityRows, leaves }) {
  const dayOfWeek = weekdayOf(date);
  const shop = weeklyHours.find((entry) => entry.dayOfWeek === dayOfWeek);
  if (!shop?.isOpen) return { capacityMinutes: 0, leaveMinutes: 0, reason: 'closed' };
  if (holidays.has(date)) return { capacityMinutes: 0, leaveMinutes: 0, reason: 'holiday' };

  let opensAt = shop.opensAt;
  let closesAt = shop.closesAt;
  let configuredCapacity = null;
  if (availabilityRows.length) {
    const row = availabilityRows.find((entry) => entry.dayOfWeek === dayOfWeek);
    if (!row?.isAvailable) return { capacityMinutes: 0, leaveMinutes: 0, reason: 'unavailable' };
    if (timeMinutes(row.opensAt) > timeMinutes(opensAt)) opensAt = row.opensAt;
    if (timeMinutes(row.closesAt) < timeMinutes(closesAt)) closesAt = row.closesAt;
    configuredCapacity = row.capacityMinutes;
  }
  if (timeMinutes(opensAt) >= timeMinutes(closesAt)) return { capacityMinutes: 0, leaveMinutes: 0, reason: 'unavailable' };

  const openUtc = localToUtc(date, opensAt, timeZone);
  const closeUtc = localToUtc(date, closesAt, timeZone);
  const windowMinutes = Math.max(0, Math.round((closeUtc - openUtc) / MINUTE));
  const base = configuredCapacity === null ? windowMinutes : Math.min(configuredCapacity, windowMinutes);
  const leaveMinutes = mergeIntervals(leaves)
    .reduce((sum, leave) => sum + overlapMinutes(openUtc, closeUtc, leave.start, leave.end), 0);
  const capacityMinutes = Math.max(0, base - leaveMinutes);
  return { capacityMinutes, leaveMinutes, reason: leaveMinutes > 0 && capacityMinutes === 0 ? 'leave' : null };
}

export function dayStatus(capacityMinutes, plannedMinutes, nearRatio = NEAR_RATIO) {
  if (plannedMinutes > capacityMinutes) return 'over';
  if (capacityMinutes === 0) return 'off';
  if (plannedMinutes >= nearRatio * capacityMinutes) return 'near';
  return 'ok';
}

/**
 * Planned minutes against capacity, per worker and business-local day.
 * tasks: only tasks that hold planned time (LOAD_STATUSES); anything else is ignored here.
 */
export function buildWorkload({ fromDate, days, timeZone, weeklyHours, holidays = [], workers, availability = [], leaves = [], tasks = [], nearRatio = NEAR_RATIO }) {
  if (!isRealDate(fromDate)) throw new RangeError('fromDate must be a real YYYY-MM-DD date.');
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new RangeError('days must be between 1 and 31.');
  const holidaySet = new Set(holidays);
  const dates = Array.from({ length: days }, (_, index) => addDays(fromDate, index));
  const ranges = new Map(dates.map((date) => [date, dayRangeUtc(date, timeZone)]));

  const result = workers.map((worker) => {
    const rows = availability.filter((entry) => entry.membershipId === worker.membershipId);
    const workerLeaves = leaves.filter((entry) => entry.membershipId === worker.membershipId);
    const workerTasks = tasks.filter((task) => task.membershipId === worker.membershipId && LOAD_STATUSES.includes(task.status)
      && task.plannedStartUtc && task.plannedEndUtc);
    const perDay = dates.map((date) => {
      const { startUtc, endUtc } = ranges.get(date);
      const capacity = workerDayCapacity({ date, timeZone, weeklyHours, holidays: holidaySet, availabilityRows: rows, leaves: workerLeaves });
      const plannedMinutes = workerTasks.reduce((sum, task) => sum + overlapMinutes(
        new Date(task.plannedStartUtc), new Date(task.plannedEndUtc), startUtc, endUtc), 0);
      return {
        date,
        capacityMinutes: capacity.capacityMinutes,
        plannedMinutes,
        leaveMinutes: capacity.leaveMinutes,
        utilization: capacity.capacityMinutes > 0 ? Math.round((plannedMinutes / capacity.capacityMinutes) * 1000) / 1000 : null,
        status: dayStatus(capacity.capacityMinutes, plannedMinutes, nearRatio),
        reason: capacity.reason,
      };
    });
    return {
      membershipId: worker.membershipId,
      displayName: worker.displayName,
      days: perDay,
      totalCapacityMinutes: perDay.reduce((sum, day) => sum + day.capacityMinutes, 0),
      totalPlannedMinutes: perDay.reduce((sum, day) => sum + day.plannedMinutes, 0),
      overDays: perDay.filter((day) => day.status === 'over').length,
    };
  });
  return {
    fromDate,
    days: dates,
    workers: result,
    totalCapacityMinutes: result.reduce((sum, worker) => sum + worker.totalCapacityMinutes, 0),
    totalPlannedMinutes: result.reduce((sum, worker) => sum + worker.totalPlannedMinutes, 0),
  };
}

/** Flags for one task. `leavesByWorker` maps a membership ID to its approved leave intervals. */
export function taskFlags(task, { now, leavesByWorker = new Map() }) {
  const open = !['Completed', 'Cancelled'].includes(task.status);
  const deadline = task.deadlineUtc ? new Date(task.deadlineUtc) : null;
  const plannedStart = task.plannedStartUtc ? new Date(task.plannedStartUtc) : null;
  const plannedEnd = task.plannedEndUtc ? new Date(task.plannedEndUtc) : null;
  const leaves = task.membershipId ? (leavesByWorker.get(task.membershipId) ?? []) : [];
  return {
    overdue: open && deadline !== null && deadline < now,
    blocked: task.status === 'Blocked',
    unassigned: open && !task.membershipId,
    noEstimate: open && (task.estimatedMinutes === null || task.estimatedMinutes === undefined),
    lateAgainstDeadline: open && deadline !== null && plannedEnd !== null && plannedEnd > deadline,
    insideLeave: open && plannedStart !== null && plannedEnd !== null
      && leaves.some((leave) => intervalsOverlap(plannedStart, plannedEnd, leave.startUtc, leave.endUtc)),
  };
}
