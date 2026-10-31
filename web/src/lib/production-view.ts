// Step-12b: types and pure helpers for the manager production screens (dashboard "needs attention",
// "today by worker", and the workload, calendar and board tabs on /tasks). The shapes mirror the
// read-only /api/production/* routes added in step-12a; nothing here talks to the network.

export interface AttentionCounts {
  openTasks: number;
  overdue: number;
  blocked: number;
  unassigned: number;
  noEstimate: number;
  lateAgainstDeadline: number;
  insideLeave: number;
}

export interface TaskFlags {
  overdue: boolean;
  blocked: boolean;
  unassigned: boolean;
  noEstimate: boolean;
  lateAgainstDeadline: boolean;
  insideLeave: boolean;
}

export interface ViewTask {
  taskId: string;
  orderId: string;
  orderNumber: string;
  title: string;
  stageName: string;
  status: string;
  priority: string;
  membershipId: string | null;
  workerName: string | null;
  startUtc: string | null;
  endUtc: string | null;
  deadlineUtc: string | null;
  estimatedMinutes: number | null;
  flags: TaskFlags;
}

export interface ProductionOverview {
  asOfUtc: string;
  timeZoneId: string;
  today: string;
  scopedToLocations: boolean;
  attention: AttentionCounts;
  todayByWorker: { membershipId: string | null; displayName: string | null; tasks: ViewTask[] }[];
  todayTruncated: boolean;
}

export type DayStatus = 'ok' | 'near' | 'over' | 'off';

export interface WorkloadDay {
  date: string;
  capacityMinutes: number;
  plannedMinutes: number;
  leaveMinutes: number;
  utilization: number | null;
  status: DayStatus | string;
  reason: string | null;
}

export interface WorkloadWorker {
  membershipId: string;
  displayName: string;
  days: WorkloadDay[];
  totalCapacityMinutes: number;
  totalPlannedMinutes: number;
  overDays: number;
  unplannedTasks: number;
  unplannedMinutes: number;
}

export interface WorkloadReport {
  timeZoneId: string;
  fromDate: string;
  /** The list of local dates the grid covers. */
  days: string[];
  scopedToLocations: boolean;
  workers: WorkloadWorker[];
  forecast: {
    totalCapacityMinutes: number;
    totalPlannedMinutes: number;
    unplannedMinutes: number;
    shortfallMinutes: number;
    overDays: number;
    unassignedTasks: number;
    tasksWithoutEstimate: number;
  };
}

export interface CalendarReport {
  timeZoneId: string;
  fromDate: string;
  /** The number of days the window covers. */
  days: number;
  scopedToLocations: boolean;
  truncated: boolean;
  slots: ViewTask[];
}

// ---- Tabs and query parameters -------------------------------------------------------------------------------

export const PRODUCTION_VIEWS = ['list', 'workload', 'calendar', 'board'] as const;
export type ProductionView = typeof PRODUCTION_VIEWS[number];

export const VIEW_LABELS: Record<ProductionView, string> = { list: 'List', workload: 'Workload', calendar: 'Calendar', board: 'Board' };
export const WORKLOAD_RANGES = [7, 14, 28] as const;
export const CALENDAR_RANGES = [7, 14, 21] as const;
export const DEFAULT_WORKLOAD_DAYS = 14;
export const DEFAULT_CALENDAR_DAYS = 7;
/** Board columns, in the order work normally moves. Completed and Cancelled work is not shown on the board. */
export const BOARD_COLUMNS = ['Pending', 'Scheduled', 'InProgress', 'Paused', 'Blocked'] as const;
export const BOARD_COLUMN_SIZE = 25;

export interface ViewQuery {
  view: ProductionView;
  /** A real YYYY-MM-DD date, or '' for "today". */
  from: string;
  days: number;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Reads ?view, ?from and ?days from a page. Anything unrecognised falls back to a safe default; it never throws. */
export function parseViewQuery(input: Record<string, string | string[] | undefined>): ViewQuery {
  const rawView = first(input.view) ?? '';
  const view = (PRODUCTION_VIEWS as readonly string[]).includes(rawView) ? (rawView as ProductionView) : 'list';
  const rawFrom = (first(input.from) ?? '').trim();
  const from = isRealDate(rawFrom) ? rawFrom : '';
  const allowed: readonly number[] = view === 'workload' ? WORKLOAD_RANGES : CALENDAR_RANGES;
  const fallback = view === 'workload' ? DEFAULT_WORKLOAD_DAYS : DEFAULT_CALENDAR_DAYS;
  const rawDays = first(input.days) ?? '';
  const days = /^\d{1,2}$/.test(rawDays) && allowed.includes(Number(rawDays)) ? Number(rawDays) : fallback;
  return { view, from, days };
}

/** The query string the production API expects for the workload and calendar routes. */
export function rangeApiQuery(query: Pick<ViewQuery, 'from' | 'days'>): string {
  const p = new URLSearchParams({ days: String(query.days) });
  if (query.from) p.set('from', query.from);
  return p.toString();
}

export function viewHref(view: ProductionView, patch: Partial<Pick<ViewQuery, 'from' | 'days'>> = {}): string {
  if (view === 'list') return '/tasks';
  const p = new URLSearchParams({ view });
  if (patch.from) p.set('from', patch.from);
  if (patch.days) p.set('days', String(patch.days));
  return `/tasks?${p.toString()}`;
}

export function boardColumnApiQuery(status: string): string {
  return new URLSearchParams({ page: '1', pageSize: String(BOARD_COLUMN_SIZE), status }).toString();
}

/** True when the API refused a plan-gated route because the business plan lacks the feature. */
export function isPlanBlocked(result: { ok: boolean; status?: number; code?: string }): boolean {
  return !result.ok && result.status === 403 && result.code === 'feature_not_in_plan';
}

// ---- Needs attention -----------------------------------------------------------------------------------------

export interface AttentionItem { key: keyof AttentionCounts; label: string; count: number; href: string | null }

/** Overdue and blocked link to the filtered task list; planned-during-leave links to the leave collisions panel. The other counts have no matching screen and are shown without a link. */
export function attentionItems(attention: AttentionCounts): AttentionItem[] {
  return [
    { key: 'overdue', label: 'Overdue', count: attention.overdue, href: '/tasks?overdue=true' },
    { key: 'blocked', label: 'Blocked', count: attention.blocked, href: '/tasks?status=Blocked' },
    { key: 'unassigned', label: 'Unassigned', count: attention.unassigned, href: null },
    { key: 'noEstimate', label: 'No time estimate', count: attention.noEstimate, href: null },
    { key: 'lateAgainstDeadline', label: 'Planned after deadline', count: attention.lateAgainstDeadline, href: null },
    { key: 'insideLeave', label: 'Planned during approved leave', count: attention.insideLeave, href: '/workers/schedule#leave-collisions' },
  ];
}

const FLAG_LABELS: [keyof TaskFlags, string][] = [
  ['overdue', 'Overdue'],
  ['blocked', 'Blocked'],
  ['unassigned', 'Unassigned'],
  ['noEstimate', 'No estimate'],
  ['lateAgainstDeadline', 'Planned after deadline'],
  ['insideLeave', 'Planned during leave'],
];

export function flagLabels(flags: TaskFlags | null | undefined): string[] {
  if (!flags) return [];
  return FLAG_LABELS.filter(([key]) => flags[key]).map(([, label]) => label);
}

export function taskStatusText(status: string): string {
  return status === 'InProgress' ? 'In progress' : status || 'Unknown';
}

// ---- Minutes and workload cells ------------------------------------------------------------------------------

export function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const STATUS_TEXT: Record<string, string> = { ok: 'Within capacity', near: 'Near capacity', over: 'Over capacity', off: 'No capacity' };
const REASON_TEXT: Record<string, string> = { closed: 'Shop closed', holiday: 'Holiday', unavailable: 'Not available', leave: 'On leave' };

export function dayStatusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

export interface WorkloadCell { text: string; status: string; statusText: string }

/** What one grid cell says. A day with no capacity names the reason; otherwise it reads "planned / capacity". */
export function workloadCell(day: WorkloadDay): WorkloadCell {
  const statusText = dayStatusText(day.status);
  if (day.capacityMinutes === 0 && day.plannedMinutes === 0) {
    return { text: (day.reason && REASON_TEXT[day.reason]) || 'No capacity', status: day.status, statusText };
  }
  return { text: `${formatMinutes(day.plannedMinutes)} / ${formatMinutes(day.capacityMinutes)}`, status: day.status, statusText };
}

// ---- Business-local dates ------------------------------------------------------------------------------------

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export function localDate(instantIso: string, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: safeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instantIso)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** "Mon 26 Oct" for a YYYY-MM-DD date. The date has no time zone of its own, so it is read as UTC. */
export function dayHeading(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${date}T00:00:00Z`));
}

/** "09:00–11:30" in the business time zone; "(to Tue 27 Oct 08:00)" is added when the slot ends on a later day. */
export function formatSlotTimes(startUtc: string | null, endUtc: string | null, timeZone: string): string {
  if (!startUtc || !endUtc) return 'Not planned';
  const zone = safeZone(timeZone);
  const time = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const base = `${time(startUtc)}–${time(endUtc)}`;
  const endDay = localDate(endUtc, zone);
  if (endDay === localDate(startUtc, zone)) return base;
  return `${time(startUtc)}–${time(endUtc)} (ends ${dayHeading(endDay)})`;
}

export interface CalendarDay { date: string; slots: ViewTask[] }

/**
 * Groups planned slots by the business-local day they start on, for every day in the window (empty days included).
 * A slot that started before the window is shown on the first day.
 */
export function groupSlotsByDay(slots: ViewTask[], fromDate: string, days: number, timeZone: string): CalendarDay[] {
  const dates = Array.from({ length: days }, (_, index) => addDays(fromDate, index));
  const byDay = new Map<string, ViewTask[]>(dates.map((date) => [date, []]));
  for (const slot of slots) {
    if (!slot.startUtc) continue;
    let day = localDate(slot.startUtc, timeZone);
    if (day < fromDate) day = fromDate;
    byDay.get(day)?.push(slot);
  }
  return dates.map((date) => ({
    date,
    slots: (byDay.get(date) ?? []).sort((a, b) => (a.startUtc ?? '').localeCompare(b.startUtc ?? '') || a.taskId.localeCompare(b.taskId)),
  }));
}
