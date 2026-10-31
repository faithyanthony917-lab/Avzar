// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../support/dom';
import type { LeaveConflict, LeaveConflictsReport, MyToday } from '@/lib/worker-today';

vi.mock('next/link', () => ({
  default: ({ href, children, className, style }: { href: string; children: ReactNode; className?: string; style?: object }) => <a href={href} className={className} style={style}>{children}</a>,
}));

import { LeaveCollisionBadge, LeaveCollisionsPanel, LeaveCollisionsUnavailable } from '@/components/app/LeaveCollisions';
import { WorkerTodayPanel } from '@/components/app/WorkerTodayPanel';

const base: MyToday = {
  asOfUtc: '2026-10-26T07:00:00Z', timeZoneId: 'Africa/Lagos', today: '2026-10-26', onLeaveToday: false, tasksTruncated: false, leave: [],
  tasks: [{
    taskId: 't1', orderId: 'o1', orderNumber: 'ORD-7', title: 'Cut sleeve', stageName: 'Cutting', status: 'Scheduled', priority: 'High',
    startUtc: '2026-10-26T08:00:00Z', endUtc: '2026-10-26T09:30:00Z', deadlineUtc: '2026-10-28T12:00:00Z', estimatedMinutes: 90,
  }],
};

describe('WorkerTodayPanel', () => {
  it('lists today\'s planned work with time, order, stage, priority and deadline', () => {
    render(<WorkerTodayPanel data={base} />);
    expect(screen.getByRole('heading', { name: 'Planned for today' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cut sleeve' })).toHaveAttribute('href', '/tasks/t1');
    expect(screen.getByText('09:00–10:30')).toBeInTheDocument();
    expect(screen.getByText(/ORD-7 · Cutting · Scheduled · High priority/)).toBeInTheDocument();
    expect(screen.getByText(/Deadline/)).toBeInTheDocument();
    expect(screen.queryByText('Your leave')).toBeNull();
  });
  it('has an empty state that points to open tasks', () => {
    render(<WorkerTodayPanel data={{ ...base, tasks: [] }} />);
    expect(screen.getByText(/Nothing is planned for you today/)).toHaveTextContent('Check Open tasks');
  });
  it('says so when the worker is on approved leave today', () => {
    render(<WorkerTodayPanel data={{ ...base, tasks: [], onLeaveToday: true }} />);
    expect(screen.getByRole('status')).toHaveTextContent('You are on approved leave today.');
    expect(screen.getByText('Nothing is planned for you today.')).toBeInTheDocument();
  });
  it('notes a cut-off list', () => {
    render(<WorkerTodayPanel data={{ ...base, tasksTruncated: true }} />);
    expect(screen.getByText(/Only the first tasks are listed/)).toBeInTheDocument();
  });
  it('lists own leave with its status and dates', () => {
    render(<WorkerTodayPanel data={{ ...base, leave: [
      { leaveId: 'l1', startsAtUtc: '2026-10-29T23:00:00Z', endsAtUtc: '2026-10-30T23:00:00Z', reason: 'Wedding', status: 'Pending' },
    ] }} />);
    expect(screen.getByRole('heading', { name: 'Your leave' })).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText(/Fri.*30 Oct, all day/)).toBeInTheDocument();
    expect(screen.getByText('Wedding')).toBeInTheDocument();
  });
});

function conflict(leaveId: string, over: Partial<LeaveConflict> = {}): LeaveConflict {
  return {
    leaveId, membershipId: 'm1', workerName: 'Ada', startsAtUtc: '2026-10-27T08:00:00Z', endsAtUtc: '2026-10-27T16:00:00Z', reason: 'Wedding', status: 'Approved',
    affectedTaskCount: 1, affectedTasksTruncated: false,
    affectedTasks: [{ taskId: `t-${leaveId}`, title: `Sew ${leaveId}`, orderNumber: 'ORD-7', status: 'Scheduled', startUtc: '2026-10-27T09:00:00Z', endUtc: '2026-10-27T10:00:00Z' }],
    ...over,
  };
}
const report = (leaves: LeaveConflict[], scopedToLocations = false): LeaveConflictsReport => ({ asOfUtc: '2026-10-26T12:00:00Z', scopedToLocations, leaves });

describe('LeaveCollisionsPanel', () => {
  it('lists colliding leave with pending first, and links the affected tasks', () => {
    render(<LeaveCollisionsPanel timeZone="Africa/Lagos" report={report([conflict('a'), conflict('p', { status: 'Pending', workerName: 'Bola', startsAtUtc: '2026-10-30T08:00:00Z', endsAtUtc: '2026-10-30T16:00:00Z' }), conflict('none', { affectedTaskCount: 0, affectedTasks: [] })])} />);
    const states = screen.getAllByText(/Waiting for approval|^Approved$/).map((node) => node.textContent);
    expect(states).toEqual(['Waiting for approval', 'Approved']);
    expect(screen.getByRole('link', { name: 'Sew p' })).toHaveAttribute('href', '/tasks/t-p');
    expect(screen.getByRole('link', { name: 'Open shop schedule' })).toHaveAttribute('href', '/tasks/schedule');
    expect(screen.getByText('Bola')).toBeInTheDocument();
    expect(screen.queryByText('Sew none')).toBeNull();
    expect(screen.getByText(/does not move the work/)).toBeInTheDocument();
  });
  it('says so when nothing collides, and notes location scoping', () => {
    render(<LeaveCollisionsPanel timeZone="Africa/Lagos" report={report([conflict('none', { affectedTaskCount: 0, affectedTasks: [] })], true)} />);
    expect(screen.getByRole('status')).toHaveTextContent('No pending or approved leave collides with planned tasks.');
    expect(screen.getByText(/your locations only/)).toBeInTheDocument();
  });
  it('has an anchor the dashboard can link to', () => {
    const { container } = render(<LeaveCollisionsPanel timeZone="UTC" report={report([])} />);
    expect(container.querySelector('#leave-collisions')).not.toBeNull();
  });
  it('has a quiet unavailable note', () => {
    render(<LeaveCollisionsUnavailable />);
    expect(screen.getByRole('status')).toHaveTextContent('approving and rejecting leave still works');
  });
});

describe('LeaveCollisionBadge', () => {
  it('renders nothing without a collision', () => {
    const { container, rerender } = render(<LeaveCollisionBadge conflict={undefined} timeZone="UTC" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<LeaveCollisionBadge conflict={conflict('x', { affectedTaskCount: 0, affectedTasks: [] })} timeZone="UTC" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the count and the first five tasks, then how many more', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => ({ taskId: `t${index}`, title: `Task ${index}`, orderNumber: 'ORD-1', status: 'Scheduled', startUtc: '2026-10-27T09:00:00Z', endUtc: '2026-10-27T10:00:00Z' }));
    render(<LeaveCollisionBadge timeZone="UTC" conflict={conflict('x', { affectedTaskCount: 50, affectedTasksTruncated: true, affectedTasks: tasks })} />);
    expect(screen.getByRole('note')).toHaveTextContent('Collides with 50+ planned tasks');
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(screen.getByText('and 45+ more')).toBeInTheDocument();
  });
});
