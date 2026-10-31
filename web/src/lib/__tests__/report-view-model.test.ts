import { describe, expect, it } from 'vitest';
import { dashboardMetricEntries, reportMetricEntries, type ReportMetrics } from '../report-view-model';

const sample: ReportMetrics = {
  currencyCode: 'NGN', ordersCreated: 4, ordersDelivered: 2, orderValue: 10000,
  verifiedRevenue: 6500, expenses: 1500, grossAfterExpenses: 5000,
  openTasks: 3, completedTasks: 8, overdueTasks: 1,
};

describe('report view models', () => {
  it('shows verified revenue separately from order value and excludes completed-task detail on dashboard', () => {
    const metrics = dashboardMetricEntries(sample);
    expect(metrics.find(([label]) => label === 'Order value')?.[1]).toContain('10,000');
    expect(metrics.find(([label]) => label === 'Verified revenue')?.[1]).toContain('6,500');
    expect(metrics.some(([label]) => label === 'Completed tasks in period')).toBe(false);
  });

  it('includes completed tasks in the detailed report and keeps expense metrics', () => {
    const metrics = reportMetricEntries(sample);
    expect(metrics.find(([label]) => label === 'Completed tasks in period')?.[1]).toBe('8');
    expect(metrics.find(([label]) => label === 'Expenses')?.[1]).toContain('1,500');
    expect(metrics).toHaveLength(9);
  });
});
