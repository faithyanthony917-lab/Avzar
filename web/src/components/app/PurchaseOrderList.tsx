'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { money } from '@/lib/format';
import { messageFor } from '@/lib/problem';
import { Pager, usePaged } from './Pager';

export type PurchaseOrderRow = {
  Id: string; OrderNumber: string; Status: string; SupplierName: string; LocationName: string;
  Subtotal: string; Currency: string; ExpectedAtUtc: string | null; CreatedAtUtc: string;
};

export const PO_STATUS_LABEL: Record<string, string> = { Draft: 'Draft', Ordered: 'Ordered', PartiallyReceived: 'Partly received', Received: 'Received', Cancelled: 'Cancelled' };
const STATUSES = Object.keys(PO_STATUS_LABEL);

export function PurchaseOrderList({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<PurchaseOrderRow[] | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setRows(await api<PurchaseOrderRow[]>('/api/purchase-orders')); }
    catch (err) { setError(messageFor(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = (rows ?? []).filter((row) => !status || row.Status === status);
  const paged = usePaged(visible);

  return <section className="ap-stack" aria-label="Purchase orders">
    <div className="ap-row">
      <div className="ap-field"><label htmlFor="po-status">Status</label>
        <select id="po-status" value={status} onChange={(event) => { setStatus(event.target.value); paged.setPage(1); }}><option value="">All</option>{STATUSES.map((key) => <option key={key} value={key}>{PO_STATUS_LABEL[key]}</option>)}</select></div>
      {canManage && <Link href="/inventory/purchase-orders/new" className="ap-btn" style={{ textDecoration: 'none' }}>New purchase order</Link>}
    </div>
    {error && <div role="alert" className="ap-alert"><p>{error}</p><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Retry loading purchase orders</button></div>}
    {rows === null && !error && <p className="ap-foot" aria-live="polite">Loading purchase orders…</p>}
    {rows && visible.length === 0 && <p className="ap-hint">{rows.length === 0 ? 'No purchase orders yet.' : 'No purchase orders with that status.'}</p>}
    {paged.slice.map((row) => <Link key={row.Id} href={`/inventory/purchase-orders/${row.Id}`} className="ap-panel ap-stack" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="ap-row"><strong>{row.OrderNumber}</strong><span className="ap-badge">{PO_STATUS_LABEL[row.Status] ?? row.Status}</span></div>
      <p className="ap-foot">{row.SupplierName} · {row.LocationName}</p>
      <p className="ap-foot">{money(Number(row.Subtotal), row.Currency)}{row.ExpectedAtUtc ? ` · expected ${new Date(row.ExpectedAtUtc).toLocaleDateString()}` : ''}</p>
    </Link>)}
    <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Purchase orders pages" />
  </section>;
}
