'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client';
import { money } from '@/lib/format';
import { messageFor } from '@/lib/problem';
import type { Supplier } from './SupplierManager';
import { toast } from '@/lib/toast';

type Place = { id: string; name: string };
type Stock = { id: string; locationId: string | null; sku: string; name: string; unit: string; active?: boolean };
type Category = { id: string; name: string; isActive: boolean };
type Line = { key: number; description: string; sku: string; quantity: string; unitCost: string; stockItemId: string };

const newLine = (key: number): Line => ({ key, description: '', sku: '', quantity: '', unitCost: '', stockItemId: '' });
const decimals = (value: string, max: number) => new RegExp(`^\\d+(?:\\.\\d{1,${max}})?$`).test(value);

export function PurchaseOrderForm({ canLinkExpense, defaultCurrency }: { canLinkExpense: boolean; defaultCurrency: string }) {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [stock, setStock] = useState<Stock[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [expected, setExpected] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine(1)]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [s, p, m] = await Promise.all([api<Supplier[]>('/api/suppliers'), api<Place[]>('/api/inventory/locations'), api<Stock[]>('/api/inventory')]);
      setSuppliers(s.filter((x) => x.IsActive)); setPlaces(p); setStock(m.filter((x) => x.active !== false));
      setLocationId((cur) => cur || (p.length === 1 ? p[0]!.id : ''));
      if (canLinkExpense) { try { setCategories((await api<Category[]>('/api/expense-categories')).filter((c) => c.isActive)); } catch { setCategories([]); } }
      setReady(true);
    } catch (err) { setLoadError(messageFor(err)); }
  }, [canLinkExpense]);
  useEffect(() => { void load(); }, [load]);

  const choices = useMemo(() => stock.filter((m) => !locationId || m.locationId === null || m.locationId === locationId), [stock, locationId]);
  const total = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitCost) || 0), 0);
  const patch = (key: number, change: Partial<Line>) => setLines((cur) => cur.map((line) => (line.key === key ? { ...line, ...change } : line)));

  function pickStock(key: number, id: string) {
    const material = stock.find((m) => m.id === id);
    setLines((cur) => cur.map((line) => (line.key === key ? { ...line, stockItemId: id, description: line.description || material?.name || '', sku: line.sku || material?.sku || '' } : line)));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    const code = currency.trim().toUpperCase();
    if (!supplierId) return setError('Choose a supplier.');
    if (!locationId) return setError('Choose the location the stock is delivered to.');
    if (!orderNumber.trim()) return setError('Enter an order number.');
    if (!/^[A-Z]{3}$/.test(code)) return setError('Use a 3-letter currency code, for example NGN.');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const label = `Item ${index + 1}`;
      if (!line.description.trim()) return setError(`${label}: enter a description.`);
      if (!line.stockItemId) return setError(`${label}: choose the stock item it adds to. Stock can only be received for linked items.`);
      if (!decimals(line.quantity, 3) || Number(line.quantity) <= 0) return setError(`${label}: enter a quantity above zero with at most 3 decimal places.`);
      if (!decimals(line.unitCost, 2)) return setError(`${label}: enter a unit cost with at most 2 decimal places.`);
    }
    setSaving(true);
    try {
      const created = await api<{ Id: string }>('/api/purchase-orders', { method: 'POST', json: {
        supplierId, locationId, orderNumber: orderNumber.trim(), currency: code,
        ...(expected ? { expectedAtUtc: `${expected}T00:00:00.000Z` } : {}),
        ...(categoryId ? { expenseCategoryId: categoryId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        items: lines.map((line) => ({ description: line.description.trim(), ...(line.sku.trim() ? { sku: line.sku.trim() } : {}), quantityOrdered: Number(line.quantity), unitCost: Number(line.unitCost), stockItemId: line.stockItemId })),
      } });
      router.push(`/inventory/purchase-orders/${created.Id}`);
    } catch (err) { toast.error(messageFor(err)); setSaving(false); }
  }

  if (loadError) return <div role="alert" className="ap-alert"><p>{loadError}</p><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Retry loading the form</button></div>;
  if (!ready) return <p className="ap-foot" aria-live="polite">Loading the form…</p>;
  if (suppliers.length === 0) return <p className="ap-hint">Add an active supplier before creating a purchase order.</p>;

  return <form className="ap-stack" onSubmit={(event) => void save(event)} noValidate>
    <div className="ap-field"><label htmlFor="po-supplier">Supplier</label>
      <select id="po-supplier" value={supplierId} onChange={(event) => setSupplierId(event.target.value)} disabled={saving}><option value="">Choose a supplier</option>{suppliers.map((s) => <option key={s.Id} value={s.Id}>{s.Name}</option>)}</select></div>
    <div className="ap-field"><label htmlFor="po-location">Deliver to</label>
      <select id="po-location" value={locationId} onChange={(event) => setLocationId(event.target.value)} disabled={saving}><option value="">Choose a location</option>{places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    <div className="ap-field"><label htmlFor="po-number">Order number</label><input id="po-number" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} maxLength={40} disabled={saving} /></div>
    <div className="ap-field"><label htmlFor="po-currency">Currency</label><input id="po-currency" value={currency} onChange={(event) => setCurrency(event.target.value)} maxLength={3} disabled={saving} /></div>
    <div className="ap-field"><label htmlFor="po-expected">Expected on (optional)</label><input id="po-expected" type="date" value={expected} onChange={(event) => setExpected(event.target.value)} disabled={saving} /></div>
    {canLinkExpense && categories.length > 0 && <div className="ap-field"><label htmlFor="po-category">Expense category (optional)</label>
      <select id="po-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} disabled={saving}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <p className="ap-foot">With a category, each receipt records an expense for the stock received.</p></div>}
    <h2 className="ap-h2">Items</h2>
    {lines.map((line, index) => <fieldset key={line.key} className="ap-panel ap-stack"><legend>Item {index + 1}</legend>
      <div className="ap-field"><label htmlFor={`po-stock-${line.key}`}>Stock item {index + 1}</label>
        <select id={`po-stock-${line.key}`} value={line.stockItemId} onChange={(event) => pickStock(line.key, event.target.value)} disabled={saving}><option value="">Choose a stock item</option>{choices.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.sku})</option>)}</select></div>
      <div className="ap-field"><label htmlFor={`po-desc-${line.key}`}>Description {index + 1}</label><input id={`po-desc-${line.key}`} value={line.description} onChange={(event) => patch(line.key, { description: event.target.value })} maxLength={240} disabled={saving} /></div>
      <div className="ap-field"><label htmlFor={`po-qty-${line.key}`}>Quantity {index + 1}</label><input id={`po-qty-${line.key}`} inputMode="decimal" value={line.quantity} onChange={(event) => patch(line.key, { quantity: event.target.value })} disabled={saving} /></div>
      <div className="ap-field"><label htmlFor={`po-cost-${line.key}`}>Unit cost {index + 1}</label><input id={`po-cost-${line.key}`} inputMode="decimal" value={line.unitCost} onChange={(event) => patch(line.key, { unitCost: event.target.value })} disabled={saving} /></div>
      {lines.length > 1 && <button type="button" className="ap-btn ap-btn-quiet" onClick={() => setLines((cur) => cur.filter((x) => x.key !== line.key))} disabled={saving}>Remove item {index + 1}</button>}
    </fieldset>)}
    {lines.length < 50 && <button type="button" className="ap-btn ap-btn-quiet" onClick={() => setLines((cur) => [...cur, newLine(Math.max(...cur.map((x) => x.key)) + 1)])} disabled={saving}>Add another item</button>}
    <p><strong>Total: {money(total, currency.trim().toUpperCase().length === 3 ? currency.trim().toUpperCase() : defaultCurrency)}</strong></p>
    <label className="ap-stack" htmlFor="po-notes"><span>Notes (optional)</span><textarea id="po-notes" className="ap-input" rows={2} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={saving} /></label>
    {error && <p role="alert" className="ap-alert">{error}</p>}
    <button type="submit" className="ap-btn" disabled={saving}>{saving ? 'Saving…' : 'Save as draft'}</button>
  </form>;
}
