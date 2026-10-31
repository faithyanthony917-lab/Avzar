'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { money } from '@/lib/format';
import { messageFor } from '@/lib/problem';
import { PO_STATUS_LABEL } from './PurchaseOrderList';
import { toast } from '@/lib/toast';

type Item = { Id: string; Description: string; Sku: string | null; QuantityOrdered: string; QuantityReceived: string; UnitCost: string; StockItemId: string | null };
export type PurchaseOrder = {
  Id: string; OrderNumber: string; Status: string; SupplierName: string; LocationName: string; Subtotal: string; Currency: string;
  ExpectedAtUtc: string | null; OrderedAtUtc: string | null; ReceivedAtUtc: string | null; Notes: string | null; items: Item[];
};

const remainingOf = (item: Item) => Math.max(0, Number(item.QuantityOrdered) - Number(item.QuantityReceived));
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function PurchaseOrderDetail({ id, canManage }: { id: string; canManage: boolean }) {
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  // One key per receipt attempt: a retry of the same entries reuses it, so a double tap cannot post stock twice.
  const receiptKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try { setPo(await api<PurchaseOrder>(`/api/purchase-orders/${id}`)); }
    catch (err) { setLoadError(messageFor(err)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function act(path: 'order' | 'cancel', done: string) {
    if (busy) return;
    setBusy(true); setError('');
    try { await api(`/api/purchase-orders/${id}/${path}`, { method: 'POST' }); toast.success(done); setConfirmCancel(false); await load(); }
    catch (err) { toast.error(messageFor(err)); }
    finally { setBusy(false); }
  }

  function setQuantity(itemId: string, value: string) {
    receiptKey.current = null;
    setQuantities((cur) => ({ ...cur, [itemId]: value }));
  }

  async function receive(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !po) return;
    setError('');
    const entries: { itemId: string; quantity: number }[] = [];
    for (const item of po.items) {
      const raw = (quantities[item.Id] ?? '').trim();
      if (!raw) continue;
      if (!/^\d+(?:\.\d{1,3})?$/.test(raw) || Number(raw) <= 0) { setError(`${item.Description}: enter a quantity above zero with at most 3 decimal places.`); return; }
      if (Number(raw) > remainingOf(item) + 1e-7) { setError(`${item.Description}: only ${remainingOf(item)} left to receive.`); return; }
      entries.push({ itemId: item.Id, quantity: Number(raw) });
    }
    if (entries.length === 0) { setError('Enter the quantity received for at least one item.'); return; }
    receiptKey.current ??= newKey();
    setBusy(true);
    try {
      const result = await api<{ duplicate: boolean }>(`/api/purchase-orders/${id}/receive`, { method: 'POST', json: { idempotencyKey: receiptKey.current, items: entries } });
      toast.success(result.duplicate ? 'That receipt was already recorded. Nothing was added twice.' : 'Stock received.');
      receiptKey.current = null; setQuantities({}); await load();
    } catch (err) { toast.error(messageFor(err)); }
    finally { setBusy(false); }
  }

  if (loadError) return <div role="alert" className="ap-alert"><p>{loadError}</p><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Retry loading this purchase order</button></div>;
  if (!po) return <p className="ap-foot" aria-live="polite">Loading purchase order…</p>;

  const canReceive = canManage && (po.Status === 'Ordered' || po.Status === 'PartiallyReceived');
  const received = po.items.some((item) => Number(item.QuantityReceived) > 0);
  const canCancel = canManage && (po.Status === 'Draft' || (po.Status === 'Ordered' && !received));

  return <section className="ap-stack" aria-label={`Purchase order ${po.OrderNumber}`}>
    <div className="ap-row"><h2 className="ap-h2">{po.OrderNumber}</h2><span className="ap-badge">{PO_STATUS_LABEL[po.Status] ?? po.Status}</span></div>
    <p className="ap-foot">{po.SupplierName} · deliver to {po.LocationName}</p>
    <p className="ap-foot">{money(Number(po.Subtotal), po.Currency)}{po.ExpectedAtUtc ? ` · expected ${new Date(po.ExpectedAtUtc).toLocaleDateString()}` : ''}{po.OrderedAtUtc ? ` · ordered ${new Date(po.OrderedAtUtc).toLocaleDateString()}` : ''}</p>
    {po.Notes && <p className="ap-pre">{po.Notes}</p>}
    {po.items.map((item) => <article key={item.Id} className="ap-panel ap-stack">
      <strong>{item.Description}</strong>
      <p className="ap-foot">Ordered {Number(item.QuantityOrdered)} · received {Number(item.QuantityReceived)} · left {remainingOf(item)} · {money(Number(item.UnitCost), po.Currency)} each</p>
      {canReceive && remainingOf(item) > 0 && (item.StockItemId
        ? <div className="ap-field"><label htmlFor={`recv-${item.Id}`}>Receive {item.Description}</label><input id={`recv-${item.Id}`} inputMode="decimal" value={quantities[item.Id] ?? ''} onChange={(event) => setQuantity(item.Id, event.target.value)} disabled={busy} /></div>
        : <p className="ap-hint">This item is not linked to a stock item, so stock cannot be received for it.</p>)}
    </article>)}
    {error && <p role="alert" className="ap-alert">{error}</p>}
    <div className="ap-actions">
      {canManage && po.Status === 'Draft' && <button type="button" className="ap-btn" onClick={() => void act('order', 'Marked as ordered.')} disabled={busy}>Mark as ordered</button>}
      {canReceive && <button type="button" className="ap-btn" onClick={(event) => void receive(event as unknown as React.FormEvent)} disabled={busy}>{busy ? 'Working…' : 'Record received stock'}</button>}
      {canCancel && !confirmCancel && <button type="button" className="ap-btn ap-btn-quiet" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel order</button>}
    </div>
    {canCancel && confirmCancel && <div role="alertdialog" aria-label="Confirm cancel" className="ap-panel ap-stack"><p>Cancel purchase order {po.OrderNumber}? This cannot be undone.</p>
      <div className="ap-actions"><button type="button" className="ap-btn" onClick={() => void act('cancel', 'Purchase order cancelled.')} disabled={busy}>Yes, cancel it</button><button type="button" className="ap-btn ap-btn-quiet" onClick={() => setConfirmCancel(false)} disabled={busy}>Keep it</button></div></div>}
  </section>;
}
