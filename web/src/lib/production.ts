import type { TaskSummary } from './production-types';

export const TASK_STATUSES = ['Pending', 'Scheduled', 'InProgress', 'Paused', 'Blocked', 'Completed', 'Cancelled'] as const;
export type TaskStatusFilter = typeof TASK_STATUSES[number] | '';
export type TaskShow = 'open' | 'all' | 'completed';

export interface ManagerTaskQuery {
  status: TaskStatusFilter;
  stage: string;
  overdue: boolean;
  page: number;
}

const first = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v;

export function parseManagerTaskQuery(input: Record<string, string | string[] | undefined>): ManagerTaskQuery {
  const rawStatus = first(input.status) ?? '';
  const rawPage = first(input.page) ?? '';
  const page = /^\d{1,5}$/.test(rawPage) && Number(rawPage) >= 1 && Number(rawPage) <= 10000 ? Number(rawPage) : 1;
  return {
    status: (TASK_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus as TaskStatusFilter : '',
    stage: (first(input.stage) ?? '').trim().slice(0, 80),
    overdue: first(input.overdue) === 'true',
    page,
  };
}

export function managerTaskApiQuery(query: ManagerTaskQuery): string {
  const p = new URLSearchParams({ page: String(query.page), pageSize: '25' });
  if (query.status) p.set('status', query.status);
  if (query.stage) p.set('stage', query.stage);
  if (query.overdue) p.set('overdue', 'true');
  return p.toString();
}

export function managerTaskListHref(query: ManagerTaskQuery, patch: Partial<ManagerTaskQuery> = {}): string {
  const next = { ...query, ...patch };
  const p = new URLSearchParams();
  if (next.status) p.set('status', next.status);
  if (next.stage) p.set('stage', next.stage);
  if (next.overdue) p.set('overdue', 'true');
  if (next.page > 1) p.set('page', String(next.page));
  const s = p.toString();
  return s ? `/tasks?${s}` : '/tasks';
}

export function workerTaskApiQuery(show: TaskShow, page = 1): string {
  const p = new URLSearchParams({ page: String(page), pageSize: '25', show });
  return p.toString();
}

export function taskStatusLabel(status: string): string {
  if (status === 'InProgress') return 'In progress';
  return status || 'Unknown';
}

export function taskStatusTone(status: string): 'on' | 'off' | 'neutral' {
  if (status === 'Completed') return 'on';
  if (status === 'Blocked' || status === 'Cancelled') return 'off';
  return 'neutral';
}

export function taskPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

export function taskNeedsAttention(task: Pick<TaskSummary, 'isOverdue' | 'status' | 'unmetDependencies' | 'isEligible'>): boolean {
  return task.isOverdue || task.status === 'Blocked' || (task.unmetDependencies > 0 && !task.isEligible);
}
