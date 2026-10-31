// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../support/dom';
import type { ProductionOverview, TaskFlags, ViewTask, WorkloadReport, CalendarReport } from '@/lib/production-view';
import type { TaskSummary } from '@/lib/production-types';

vi.mock('next/link', () => ({
  default: ({ href, children, className, style, ...rest }: { href: string; children: ReactNode; className?: string; style?: object; 'aria-current'?: 'page' }) => <a href={href} className={className} style={style} aria-current={rest['aria-current']}>{children}</a>,
}));

import { CalendarAgenda } from '@/components/app/CalendarAgenda';
import { ProductionOverviewError, ProductionOverviewSections } from '@/components/app/ProductionOverviewSections';
import { PlanBlockedNotice, ProductionRangeForm, ProductionViewTabs } from '@/components/app/ProductionViewTabs';
import { TaskBoard } from '@/components/app/TaskBoard';
import { WorkloadGrid } from '@/components/app/WorkloadGrid';

const noFlags: TaskFlags = { overdue: false, blocked: false, unassigned: false, noEstimate: false, lateAgainstDeadline: false, insideLeave: false };
function task(id: string, over: Partial<ViewTask> = {}): ViewTask {
  return {
    taskId: id, orderId: 'o1', orderNumber: 'ORD-7', title: `Cut ${id}`, stageName: 'Cutting', status: 'Scheduled', priority: 'Normal',
    membershipId: 'm1', workerName: 'Ada', startUtc: '2026-10-26T08:00:00Z', endUtc: '2026-10-26T09:30:00Z', deadlineUtc: null, estimatedMinutes: 90,
    flags: noFlags, ...over,
  };
}
const attention = { openTasks: 12, overdue: 2, blocked: 1, unassigned: 0, noEstimate: 3, lateAgainstDeadline: 0, insideLeave: 1 };
function overview(over: Partial<ProductionOverview> = {}): ProductionOverview {
  return {
    asOfUtc: '2026-10-26T07:00:00Z', timeZoneId: 'Africa/Lagos', today: '2026-10-26', scopedToLocations: false, attention,
    todayByWorker: [
      { membershipId: 'm1', displayName: 'Ada', tasks: [task('a', { flags: { ...noFlags, overdue: true } })] },
      { membershipId: null, displayName: null, tasks: [task('b', { membershipId: null, workerName: null })] },
    ],
    todayTruncated: false, ...over,
  };
}

describe('ProductionOverviewSections', () => {
  it('shows the counts and links overdue, blocked and planned-during-leave', () => {
    render(<ProductionOverviewSections overview={overview()} />);
    expect(screen.getByRole('heading', { name: 'Production needs attention' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overdue' })).toHaveAttribute('href', '/tasks?overdue=true');
    expect(screen.getByRole('link', { name: 'Blocked' })).toHaveAttribute('href', '/tasks?status=Blocked');
    expect(screen.queryByRole('link', { name: 'No time estimate' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Planned during approved leave' })).toHaveAttribute('href', '/workers/schedule#leave-collisions');
    expect(screen.getByText('No time estimate')).toBeInTheDocument();
  });
  it('lists today by worker, with an Unassigned group and warning labels', () => {
    render(<ProductionOverviewSections overview={overview()} />);
    expect(screen.getByRole('heading', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unassigned' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cut a' })).toHaveAttribute('href', '/tasks/a');
    expect(screen.getAllByText('09:00–10:30', { selector: 'td' })).toHaveLength(2);
    const warnings = screen.getAllByLabelText('Warnings');
    expect(within(warnings[0]!).getByText('Overdue')).toBeInTheDocument();
  });
  it('says so when nothing needs attention or is planned', () => {
    render(<ProductionOverviewSections overview={overview({ attention: { ...attention, overdue: 0, blocked: 0, noEstimate: 0, insideLeave: 0 }, todayByWorker: [] })} />);
    expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument();
    expect(screen.getByText(/No tasks are planned for today/)).toBeInTheDocument();
  });
  it('notes truncation and location scoping', () => {
    render(<ProductionOverviewSections overview={overview({ todayTruncated: true, scopedToLocations: true })} />);
    expect(screen.getByText(/Only the first planned tasks are listed/)).toBeInTheDocument();
    expect(screen.getByText(/your locations only/)).toBeInTheDocument();
  });
  it('has an error state that does not hide the page', () => {
    render(<ProductionOverviewError />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  });
});

describe('WorkloadGrid', () => {
  const day = (date: string, capacityMinutes: number, plannedMinutes: number, status: string, reason: string | null = null) => ({ date, capacityMinutes, plannedMinutes, leaveMinutes: 0, utilization: null, status, reason });
  const report = (over: Partial<WorkloadReport> = {}): WorkloadReport => ({
    timeZoneId: 'Africa/Lagos', fromDate: '2026-10-26', days: ['2026-10-26', '2026-10-27'], scopedToLocations: false,
    workers: [
      { membershipId: 'm1', displayName: 'Ada', days: [day('2026-10-26', 480, 360, 'ok'), day('2026-10-27', 480, 520, 'over')], totalCapacityMinutes: 960, totalPlannedMinutes: 880, overDays: 1, unplannedTasks: 2, unplannedMinutes: 120 },
      { membershipId: 'm2', displayName: 'Bola', days: [day('2026-10-26', 0, 0, 'off', 'holiday'), day('2026-10-27', 480, 450, 'near')], totalCapacityMinutes: 480, totalPlannedMinutes: 450, overDays: 0, unplannedTasks: 0, unplannedMinutes: 0 },
    ],
    forecast: { totalCapacityMinutes: 1440, totalPlannedMinutes: 1330, unplannedMinutes: 150, shortfallMinutes: 40, overDays: 1, unassignedTasks: 3, tasksWithoutEstimate: 1 },
    ...over,
  });
  it('shows planned against capacity with words for the status', () => {
    render(<WorkloadGrid report={report()} />);
    expect(screen.getByText('6h / 8h')).toBeInTheDocument();
    expect(screen.getByText('8h 40m / 8h')).toBeInTheDocument();
    expect(screen.getByText('Over capacity')).toBeInTheDocument();
    expect(screen.getByText('Near capacity')).toBeInTheDocument();
    expect(screen.getByText('Holiday')).toBeInTheDocument();
    expect(screen.getByText('2 tasks, 2h')).toBeInTheDocument();
    expect(screen.getByText('1 day over')).toBeInTheDocument();
  });
  it('states a shortfall, or that the work fits', () => {
    const { unmount } = render(<WorkloadGrid report={report()} />);
    expect(screen.getByText('Short by 40m.')).toBeInTheDocument();
    unmount();
    render(<WorkloadGrid report={report({ forecast: { ...report().forecast, shortfallMinutes: 0 } })} />);
    expect(screen.getByText(/fits the capacity/)).toBeInTheDocument();
  });
  it('has an empty state and a location note', () => {
    render(<WorkloadGrid report={report({ workers: [], scopedToLocations: true })} />);
    expect(screen.getByText(/No active workers to show/)).toBeInTheDocument();
    expect(screen.getByText(/your locations only/)).toBeInTheDocument();
  });
});

describe('CalendarAgenda', () => {
  const report = (over: Partial<CalendarReport> = {}): CalendarReport => ({
    timeZoneId: 'Africa/Lagos', fromDate: '2026-10-26', days: 3, scopedToLocations: false, truncated: false,
    slots: [task('t1', { flags: { ...noFlags, overdue: true } })], ...over,
  });
  it('shows one block per day, with empty days marked', () => {
    render(<CalendarAgenda report={report()} />);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3);
    expect(screen.getAllByText('Nothing planned.')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Cut t1' })).toHaveAttribute('href', '/tasks/t1');
    expect(screen.getByText('09:00–10:30')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });
  it('explains an empty range and a cut-off list', () => {
    const { unmount } = render(<CalendarAgenda report={report({ slots: [] })} />);
    expect(screen.getByText(/No tasks are planned in this range/)).toBeInTheDocument();
    unmount();
    render(<CalendarAgenda report={report({ truncated: true })} />);
    expect(screen.getByText(/cut off at 500 planned tasks/)).toBeInTheDocument();
  });
});

describe('TaskBoard', () => {
  const summary = (id: string, over: Partial<TaskSummary> = {}): TaskSummary => ({
    id, orderId: 'o1', orderNumber: 'ORD-7', orderGarmentId: 'g1', garmentName: 'Agbada', stageName: 'Cutting', stageOrder: 1, title: `Sew ${id}`, quantity: 1,
    status: 'Pending', priority: 'High', deadlineUtc: null, isOverdue: false, assigneeMembershipId: null, assigneeName: null, requiredSkill: null,
    estimatedMinutes: null, needsEstimate: true, unmetDependencies: 0, isEligible: true, isConditional: false, blockedType: null, blockedReason: null, version: 1, ...over,
  });
  it('shows cards, totals and a link to the filtered list', () => {
    render(<TaskBoard timeZoneId="Africa/Lagos" columns={[
      { status: 'Pending', total: 30, items: [summary('p1')], failed: false },
      { status: 'InProgress', total: 0, items: [], failed: false },
    ]} />);
    expect(screen.getByRole('link', { name: 'Sew p1' })).toHaveAttribute('href', '/tasks/p1');
    expect(screen.getByText(/Showing 1 of 30/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/tasks?status=Pending');
    expect(screen.getByText('Unassigned · High priority')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /In progress/ })).toBeInTheDocument();
    expect(screen.getByText('No in progress tasks.')).toBeInTheDocument();
  });
  it('shows a failed column without hiding the others', () => {
    render(<TaskBoard timeZoneId="Africa/Lagos" columns={[
      { status: 'Blocked', total: 0, items: [], failed: true },
      { status: 'Paused', total: 1, items: [summary('q1', { status: 'Paused' })], failed: false },
    ]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.getByRole('link', { name: 'Sew q1' })).toBeInTheDocument();
  });
});

describe('tabs, range form and plan notice', () => {
  it('marks the active tab and links every view', () => {
    render(<ProductionViewTabs active="calendar" />);
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'List' })).toHaveAttribute('href', '/tasks');
    expect(screen.getByRole('link', { name: 'Workload' })).toHaveAttribute('href', '/tasks?view=workload');
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/tasks?view=board');
  });
  it('keeps the chosen range in the form, and offers a way back to today', () => {
    const { container, unmount } = render(<ProductionRangeForm view="workload" from="2026-10-26" days={14} ranges={[7, 14, 28]} />);
    expect(container.querySelector('input[name=view]')).toHaveValue('workload');
    expect(container.querySelector('input[name=from]')).toHaveValue('2026-10-26');
    expect(container.querySelector('select[name=days]')).toHaveValue('14');
    expect(screen.getByRole('link', { name: 'Back to today' })).toHaveAttribute('href', '/tasks?view=workload&days=14');
    unmount();
    render(<ProductionRangeForm view="workload" from="" days={14} ranges={[7, 14, 28]} />);
    expect(screen.queryByRole('link', { name: 'Back to today' })).toBeNull();
  });
  it('explains a plan-gated tab and points to billing', () => {
    render(<PlanBlockedNotice />);
    expect(screen.getByRole('status')).toHaveTextContent('not part of your current plan');
    expect(screen.getByRole('link', { name: 'View plans and billing' })).toHaveAttribute('href', '/settings/billing');
  });
});
