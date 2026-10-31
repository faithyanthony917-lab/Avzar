import { LoadError } from '@/components/app/Notices';
import { CalendarAgenda } from '@/components/app/CalendarAgenda';
import { PlanBlockedNotice, ProductionRangeForm, ProductionViewTabs } from '@/components/app/ProductionViewTabs';
import { TaskBoard, type BoardColumn } from '@/components/app/TaskBoard';
import { WorkloadGrid } from '@/components/app/WorkloadGrid';
import type { Paged } from '@/lib/customer-types';
import type { TaskSummary } from '@/lib/production-types';
import { serverGet } from '@/lib/session';
import {
  BOARD_COLUMNS, CALENDAR_RANGES, WORKLOAD_RANGES, boardColumnApiQuery, isPlanBlocked, rangeApiQuery,
  type CalendarReport, type ViewQuery, type WorkloadReport,
} from '@/lib/production-view';

function Header() {
  return <div className="ap-row" style={{ marginBottom: '1rem' }}><h1 style={{ margin: 0 }}>Production</h1><span className="ap-foot">Manager view</span></div>;
}

/** The Workload, Calendar and Board tabs of /tasks. The caller has already checked tasks.view. */
export async function productionViewScreen(query: ViewQuery, timeZoneId: string) {
  if (query.view === 'workload') {
    const result = await serverGet<WorkloadReport>(`/api/production/workload?${rangeApiQuery(query)}`);
    return <>
      <Header />
      <ProductionViewTabs active="workload" />
      {isPlanBlocked(result) ? <PlanBlockedNotice /> : !result.ok ? <LoadError status={result.status} /> : <>
        <ProductionRangeForm view="workload" from={query.from} days={query.days} ranges={WORKLOAD_RANGES} />
        <div style={{ marginTop: '1rem' }}><WorkloadGrid report={result.data} /></div>
      </>}
    </>;
  }
  if (query.view === 'calendar') {
    const result = await serverGet<CalendarReport>(`/api/production/calendar?${rangeApiQuery(query)}`);
    return <>
      <Header />
      <ProductionViewTabs active="calendar" />
      {isPlanBlocked(result) ? <PlanBlockedNotice /> : !result.ok ? <LoadError status={result.status} /> : <>
        <ProductionRangeForm view="calendar" from={query.from} days={query.days} ranges={CALENDAR_RANGES} />
        <div style={{ marginTop: '1rem' }}><CalendarAgenda report={result.data} /></div>
      </>}
    </>;
  }
  const results = await Promise.all(BOARD_COLUMNS.map((status) => serverGet<Paged<TaskSummary>>(`/api/tasks?${boardColumnApiQuery(status)}`)));
  const columns: BoardColumn[] = BOARD_COLUMNS.map((status, index) => {
    const result = results[index]!;
    return result.ok
      ? { status, total: result.data.totalCount, items: result.data.items, failed: false }
      : { status, total: 0, items: [], failed: true };
  });
  return <>
    <Header />
    <ProductionViewTabs active="board" />
    <TaskBoard columns={columns} timeZoneId={timeZoneId} />
  </>;
}
