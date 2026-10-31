// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

const download = vi.fn();
let pathname = '/reports';
vi.mock('@/lib/csv-download', () => ({ downloadCsvRows: (...args: unknown[]) => download(...args) }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { ReconciliationExport } from '@/components/app/ReconciliationExport';
import { ReportTabs } from '@/components/app/ReportTabs';
import type { ReconciliationReport } from '@/lib/reconciliation';

const empty = { count: 0, amount: 0, truncated: false, items: [] };
const report = {
  from: '2026-10-01', to: '2026-10-27', asOf: '2026-10-27', currencyCode: 'NGN', attentionCount: 0,
  collected: { count: 1, amount: 50, online: { count: 0, amount: 0 }, staffRecorded: { count: 1, amount: 50 }, byMethod: [{ method: 'Cash', online: false, count: 1, amount: 50 }] },
  needsAttention: { needsReviewPayments: empty, staleLinks: empty, pendingVerification: { ...empty, thresholdDays: 3 }, paymentsOnVoidedInvoices: empty, onlineMismatches: empty },
  invoices: { openCount: 0, openBalance: 0, overdueCount: 0, overdueBalance: 0, installmentsOverdue: { plans: 0, installments: 0, amount: 0, truncated: false, items: [] } },
} as ReconciliationReport;

beforeEach(() => { download.mockReset(); pathname = '/reports'; });

describe('ReconciliationExport', () => {
  it('downloads the report as a CSV named for its dates', () => {
    render(<ReconciliationExport report={report} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(download).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = download.mock.calls[0]!;
    expect(filename).toBe('payment-reconciliation-2026-10-01-to-2026-10-27.csv');
    expect(headers[0]).toBe('Section');
    expect(rows).toEqual([['Collected', '', 50, 'NGN', '', 'Cash', '1 payment', '2026-10-01 to 2026-10-27']]);
  });
});

describe('ReportTabs', () => {
  it('shows nothing to a user who cannot see payments', () => {
    const { container } = render(<ReportTabs showReconciliation={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks the current report', () => {
    const { rerender } = render(<ReportTabs showReconciliation />);
    expect(screen.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Payment reconciliation' })).not.toHaveAttribute('aria-current');
    pathname = '/reports/reconciliation';
    rerender(<ReportTabs showReconciliation />);
    expect(screen.getByRole('link', { name: 'Payment reconciliation' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Payment reconciliation' })).toHaveAttribute('href', '/reports/reconciliation');
  });
});
