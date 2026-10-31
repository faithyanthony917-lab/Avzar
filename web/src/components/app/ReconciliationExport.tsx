'use client';

import { downloadCsvRows } from '@/lib/csv-download';
import { reconciliationCsv, type ReconciliationReport } from '@/lib/reconciliation';

export function ReconciliationExport({ report }: { report: ReconciliationReport }) {
  return (
    <button type="button" className="ap-btn ap-btn-quiet" onClick={() => {
      const { headers, rows } = reconciliationCsv(report);
      downloadCsvRows(`payment-reconciliation-${report.from}-to-${report.to}.csv`, headers, rows);
    }}>Download CSV</button>
  );
}
