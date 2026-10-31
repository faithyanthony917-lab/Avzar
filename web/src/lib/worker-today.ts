// Step-12c: types and pure helpers for the worker "Today" tab (GET /api/my/today) and for leave that collides with
// planned tasks (GET /api/production/leave-conflicts, added in step-12a). Nothing here talks to the network.
import { addDays, dayHeading, formatSlotTimes, localDate } from './production-view';

export interface MyTodayTask {
  taskId: string;
  orderId: string;
  orderNumber: string;
  title: string;
  stageName: string;
  status: string;
  priority: string;
  startUtc: string;
  endUtc: string;
  deadlineUtc: string | null;
  estimatedMinutes: number | null;
}

export interface MyLeave { leaveId: string; startsAtUtc: string; endsAtUtc: string; reason: string; status: string }

export interface MyToday {
  asOfUtc: string;
  timeZoneId: string;
  today: string;
  onLeaveToday: boolean;
  tasksTruncated: boolean;
  tasks: MyTodayTask[];
  leave: MyLeave[];
}

export interface LeaveConflictTask { taskId: string; title: string; orderNumber: string; status: string; startUtc: string | null; endUtc: string | null }

export interface LeaveConflict {
  leaveId: string;
  membershipId: string;
  workerName: string | null;
  startsAtUtc: string;
  endsAtUtc: string;
  reason: string;
  status: string;
  affectedTaskCount: number;
  affectedTasksTruncated: boolean;
  affectedTasks: LeaveConflictTask[];
}

export interface LeaveConflictsReport { asOfUtc: string; scopedToLocations: boolean; leaves: LeaveConflict[] }

// ---- Worker tabs --------------------------------------------------------------------------------------------

export type WorkerShow = 'today' | 'open' | 'completed' | 'all';

export function parseWorkerShow(raw: string | string[] | undefined): WorkerShow {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'today' || value === 'completed' || value === 'all' ? value : 'open';
}

export const WORKER_TABS: { show: WorkerShow; label: string; href: string }[] = [
  { show: 'today', label: 'Today', href: '/tasks?show=today' },
  { show: 'open', label: 'Open tasks', href: '/tasks' },
  { show: 'completed', label: 'Completed', href: '/tasks?show=completed' },
  { show: 'all', label: 'All tasks', href: '/tasks?show=all' },
];

// ---- Leave ---------------------------------------------------------------------------------------------------

const timeIn = (iso: string, timeZone: string) => formatSlotTimes(iso, iso, timeZone).split('–')[0]!;

/** "Tue 27 Oct 09:00 – Wed 28 Oct 09:00", or "Tue 27 Oct 09:00–17:00" for one day, in the business time zone. */
export function formatLeaveRange(startsAtUtc: string, endsAtUtc: string, timeZone: string): string {
  const startDay = localDate(startsAtUtc, timeZone);
  const endDay = localDate(endsAtUtc, timeZone);
  const start = timeIn(startsAtUtc, timeZone);
  const end = timeIn(endsAtUtc, timeZone);
  if (startDay === endDay) return `${dayHeading(startDay)} ${start}–${end}`;
  // Leave that ends exactly at midnight ends on the previous day for a reader.
  if (end === '00:00' && addDays(startDay, 1) <= endDay) {
    const lastDay = addDays(endDay, -1);
    if (start === '00:00') return lastDay === startDay ? `${dayHeading(startDay)}, all day` : `${dayHeading(startDay)} – ${dayHeading(lastDay)}, all day`;
  }
  return `${dayHeading(startDay)} ${start} – ${dayHeading(endDay)} ${end}`;
}

export function leaveStatusText(status: string): string {
  return status === 'Pending' ? 'Waiting for approval' : status === 'Approved' ? 'Approved' : status;
}

/** Leave that collides with at least one planned task: pending first (it still needs a decision), then by start. */
export function collidingLeaves(report: LeaveConflictsReport): LeaveConflict[] {
  return report.leaves
    .filter((leave) => leave.affectedTaskCount > 0)
    .sort((a, b) => Number(b.status === 'Pending') - Number(a.status === 'Pending') || a.startsAtUtc.localeCompare(b.startsAtUtc) || a.leaveId.localeCompare(b.leaveId));
}

export function conflictsByLeaveId(report: LeaveConflictsReport): Record<string, LeaveConflict> {
  return Object.fromEntries(report.leaves.filter((leave) => leave.affectedTaskCount > 0).map((leave) => [leave.leaveId, leave]));
}

/** "Collides with 1 planned task", or "Collides with 50+ planned tasks" when the API cut the list. */
export function collisionLabel(conflict: Pick<LeaveConflict, 'affectedTaskCount' | 'affectedTasksTruncated'>): string {
  const count = `${conflict.affectedTaskCount}${conflict.affectedTasksTruncated ? '+' : ''}`;
  return `Collides with ${count} planned task${conflict.affectedTaskCount === 1 && !conflict.affectedTasksTruncated ? '' : 's'}`;
}
