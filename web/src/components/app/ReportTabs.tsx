'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function ReportTabs({ showReconciliation }: { showReconciliation: boolean }) {
  const path = usePathname();
  if (!showReconciliation) return null;
  return (
    <nav aria-label="Report sections" className="ap-tabs">
      <Link href="/reports" aria-current={path === '/reports' ? 'page' : undefined}>Summary</Link>
      <Link href="/reports/reconciliation" aria-current={path === '/reports/reconciliation' ? 'page' : undefined}>Payment reconciliation</Link>
    </nav>
  );
}
