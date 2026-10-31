// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../support/dom';
import type { AmendmentImpact } from '@/lib/order-types';
import { AmendmentImpactPanel } from '@/components/app/AmendmentImpactPanel';

const impact = (over: Partial<AmendmentImpact> = {}): AmendmentImpact => ({
  total: { previous: 40000, next: 45000 },
  promisedDate: { previous: '2026-10-30', next: '2026-10-30' },
  priority: { previous: 'Normal', next: 'Normal' },
  garments: { added: 0, removed: 0, categoryChanges: [] },
  tasks: { unscheduled: 2, updated: 4, cancelled: 0, created: 0 },
  linesWithoutWorkflow: 0,
  scheduleReplanRequired: true,
  ...over,
});

function show(props: Partial<Parameters<typeof AmendmentImpactPanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const onBack = vi.fn();
  render(<AmendmentImpactPanel orderNumber="ORD-7" currency="NGN" impact={impact()} busy={false} error={null} canReplan onConfirm={onConfirm} onBack={onBack} {...props} />);
  return { onConfirm, onBack };
}

describe('AmendmentImpactPanel', () => {
  it('lists what changes and says nothing is saved yet', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Review the changes to ORD-7' })).toBeInTheDocument();
    expect(screen.getByText('Nothing is saved yet.')).toBeInTheDocument();
    expect(screen.getByText('2 scheduled tasks lose their time slot and must be planned again.')).toBeInTheDocument();
  });

  it('confirms and goes back through its two buttons', () => {
    const { onConfirm, onBack } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm amendment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while saving', () => {
    show({ busy: true });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDisabled();
  });

  it('shows a save error as an alert and keeps the buttons usable', () => {
    show({ error: 'Void or settle the existing invoice workflow before changing the order total.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Void or settle the existing invoice workflow');
    expect(screen.getByRole('button', { name: 'Confirm amendment' })).toBeEnabled();
  });

  it('tells a user without task permission who must publish the new schedule, and says nothing when no re-plan is needed', () => {
    const { unmount } = render(<AmendmentImpactPanel orderNumber="ORD-7" currency="NGN" impact={impact()} busy={false} error={null} canReplan={false} onConfirm={() => {}} onBack={() => {}} />);
    expect(screen.getByText(/someone who can manage tasks must preview and publish/)).toBeInTheDocument();
    unmount();
    show({ impact: impact({ scheduleReplanRequired: false, tasks: { unscheduled: 0, updated: 0, cancelled: 0, created: 0 } }) });
    expect(screen.queryByText(/publish a new schedule/)).not.toBeInTheDocument();
  });
});
