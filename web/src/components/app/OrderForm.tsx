'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import type { CustomerSummary, Paged } from '@/lib/customer-types';
import type { Location } from '@/lib/staff-types';
import type { AmendmentImpact, Order, OrderGarment } from '@/lib/order-types';
import { ApiError, messageFor } from '@/lib/problem';
import { Field, SelectField, TextAreaField } from './Field';
import { AmendmentImpactPanel } from './AmendmentImpactPanel';

type GarmentDraft = {
  id?: string;
  name: string;
  category: string;
  quantity: string;
  unitPrice: string;
  fabric: string;
  colour: string;
  styleInstructions: string;
  alterationNotes: string;
  measurementSetId: string | null;
  measurementRevision: number | null;
  designId: string | null;
};

const blankGarment = (): GarmentDraft => ({
  name: '', category: '', quantity: '1', unitPrice: '0', fabric: '', colour: '',
  styleInstructions: '', alterationNotes: '', measurementSetId: null, measurementRevision: null, designId: null,
});
const asDraft = (g: OrderGarment): GarmentDraft => ({
  id: g.id, name: g.name, category: g.category ?? '', quantity: String(g.quantity), unitPrice: String(g.unitPrice),
  fabric: g.fabric ?? '', colour: g.colour ?? '', styleInstructions: g.styleInstructions ?? '', alterationNotes: g.alterationNotes ?? '',
  measurementSetId: g.measurementSetId, measurementRevision: g.measurementRevision, designId: g.designId,
});
const blankToNull = (v: string) => v.trim() || null;

export function OrderForm({ customers, locations, today, order, amend = false, canReplan = false }: {
  customers: CustomerSummary[];
  locations: Location[];
  today: string;
  order?: Order;
  amend?: boolean;
  canReplan?: boolean;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(order?.customerId ?? '');
  const [locationId, setLocationId] = useState(order?.locationId ?? locations[0]?.id ?? '');
  const [promisedDate, setPromisedDate] = useState(order?.promisedDate ?? today);
  const [priority, setPriority] = useState(order?.priority ?? 'Normal');
  const [deliveryMethod, setDeliveryMethod] = useState(order?.deliveryMethod ?? 'Collection');
  const [deliveryAddress, setDeliveryAddress] = useState(order?.deliveryAddress ?? '');
  const [deliveryInstructions, setDeliveryInstructions] = useState(order?.deliveryInstructions ?? '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [discount, setDiscount] = useState(String(order?.discount ?? 0));
  const [garments, setGarments] = useState<GarmentDraft[]>(order?.garments.map(asDraft) ?? [blankGarment()]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerSummary[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  // Amend mode: the request that was previewed and what the server says it would change.
  const [pending, setPending] = useState<{ body: Record<string, unknown>; impact: AmendmentImpact } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  function changed<T>(setter: (value: T) => void, value: T) {
    setIdempotencyKey(null);
    setter(value);
  }
  function updateGarment(index: number, patch: Partial<GarmentDraft>) {
    setIdempotencyKey(null);
    setGarments((current) => current.map((g, i) => i === index ? { ...g, ...patch } : g));
  }

  async function searchCustomers() {
    if (searchBusy) return;
    setSearchBusy(true); setError(null);
    try {
      const result = await api<Paged<CustomerSummary>>(`/api/customers?${new URLSearchParams({ page: '1', pageSize: '25', status: 'Active', search: customerSearch.trim(), sort: 'name' })}`);
      setCustomerResults(result.items);
    } catch (e) { setError(messageFor(e)); }
    finally { setSearchBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!locationId) { setError('Choose a workshop location before saving.'); return; }
    if (!order && !customerId) { setError('Choose a customer before saving.'); return; }
    if (!promisedDate || (promisedDate < today && promisedDate !== order?.promisedDate)) { setError('The promised date cannot be in the past.'); return; }
    if (deliveryMethod === 'Delivery' && !deliveryAddress.trim()) { setError('Enter a delivery address for delivery orders.'); return; }
    if (garments.length === 0 || garments.some((g) => !g.name.trim() || !Number.isInteger(Number(g.quantity)) || Number(g.quantity) < 1 || !Number.isFinite(Number(g.unitPrice)) || Number(g.unitPrice) < 0)) {
      setError('Each garment needs a name, a whole-number quantity of at least 1, and a valid non-negative unit price.'); return;
    }
    const body = {
      ...(order ? { version: order.version } : { customerId }),
      locationId, promisedDate, priority, deliveryMethod,
      deliveryAddress: blankToNull(deliveryAddress), deliveryInstructions: blankToNull(deliveryInstructions),
      notes: blankToNull(notes), discount: Number(discount || 0),
      garments: garments.map((g) => ({
        ...(g.id ? { id: g.id } : {}), name: g.name.trim(), category: blankToNull(g.category),
        quantity: Number(g.quantity), unitPrice: Number(g.unitPrice), fabric: blankToNull(g.fabric), colour: blankToNull(g.colour),
        styleInstructions: blankToNull(g.styleInstructions), alterationNotes: blankToNull(g.alterationNotes),
        measurementSetId: g.measurementSetId, measurementRevision: g.measurementRevision, designId: g.designId,
      })),
    };
    if (order && amend) { await previewAmendment(order.id, body); return; }
    setBusy(true);
    try {
      if (order) {
        const saved = await api<Order>(`/api/orders/${order.id}`, { method: 'PUT', json: body });
        router.push(`/orders/${saved.id}`);
      } else {
        const key = idempotencyKey ?? crypto.randomUUID();
        setIdempotencyKey(key);
        const saved = await api<Order>('/api/orders', { method: 'POST', json: body, idempotencyKey: key });
        router.push(`/orders/${saved.id}`);
      }
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale_version') setError('This order changed after you opened it. Reload the page before trying again. Your current edits have not been saved.');
      else setError(messageFor(e));
    } finally { setBusy(false); }
  }

  const staleMessage = 'This order changed after you opened it. Reload the page before trying again. Your current edits have not been saved.';

  // Asks the server what the amendment would change. Nothing is saved by this call.
  async function previewAmendment(orderId: string, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await api<{ impact: AmendmentImpact }>(`/api/orders/${orderId}/amend/preview`, { method: 'POST', json: body });
      setConfirmError(null);
      setPending({ body, impact: result.impact });
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'stale_version' ? staleMessage : messageFor(e));
    } finally { setBusy(false); }
  }

  async function confirmAmendment() {
    if (!order || !pending || busy) return;
    setBusy(true); setConfirmError(null);
    try {
      const result = await api<{ order: Order; scheduleReplanRequired: boolean }>(`/api/orders/${order.id}/amend`, { method: 'POST', json: pending.body });
      router.push(result.scheduleReplanRequired && canReplan
        ? `/tasks/schedule?replan=order-amendment&order=${encodeURIComponent(result.order.orderNumber)}`
        : result.scheduleReplanRequired
          ? `/orders/${result.order.id}?scheduleReplanRequired=1`
          : `/orders/${result.order.id}`);
      router.refresh();
    } catch (e) {
      setConfirmError(e instanceof ApiError && e.code === 'stale_version' ? staleMessage : messageFor(e));
    } finally { setBusy(false); }
  }

  if (amend && order && pending) {
    return (
      <AmendmentImpactPanel orderNumber={order.orderNumber} currency={order.currencyCode} impact={pending.impact} busy={busy}
        error={confirmError} canReplan={canReplan} onConfirm={confirmAmendment} onBack={() => { setPending(null); setConfirmError(null); }} />
    );
  }

  const selectedCustomer = customerResults?.some((c) => c.id === customerId) ? customerId : '';

  return (
    <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy}>
      <h2 className="ap-h2">{amend && order ? `Amend ${order.orderNumber}` : order ? `Edit ${order.orderNumber}` : 'New order'}</h2>
      {amend && <p className="ap-hint">Amendments are allowed only before production starts. You will see what changes before anything is saved.</p>}
      {error && <p role="alert" className="ap-alert">{error}</p>}
      {!order && (
        <div className="ap-field">
          <label htmlFor="order-customer">Customer</label>
          <select id="order-customer" value={customerId} onChange={(e) => changed(setCustomerId, e.target.value)} required>
            <option value="">Choose a customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.fullName}{c.phone ? ` · ${c.phone}` : ''}</option>)}
            {customerId && !customers.some((c) => c.id === customerId) && <option value={customerId}>{customerResults?.find((c) => c.id === customerId)?.fullName ?? 'Selected customer'}</option>}
          </select>
          <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
            <input className="ap-input" aria-label="Search active customers" placeholder="Search customers by name, email or phone" value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} maxLength={100} />
            <button type="button" className="ap-btn ap-btn-quiet" onClick={() => void searchCustomers()} disabled={searchBusy}>{searchBusy ? 'Searching…' : 'Search'}</button>
          </div>
          {customerResults && <div className="ap-field"><label htmlFor="order-customer-results">Search results</label><select id="order-customer-results" value={selectedCustomer} onChange={(e) => changed(setCustomerId, e.target.value)}><option value="">Choose a result</option>{customerResults.map((c) => <option key={c.id} value={c.id}>{c.fullName}{c.phone ? ` · ${c.phone}` : ''}</option>)}</select><p className="ap-hint">Only active customer records are shown. Create a customer first if the person is not listed.</p></div>}
        </div>
      )}
      <div className="ap-grid2">
        <SelectField id="order-location" label="Workshop location" value={locationId} onChange={(v) => changed(setLocationId, v)} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
        <Field id="order-promised" label="Promised date" type="date" min={today} required value={promisedDate} onChange={(v) => changed(setPromisedDate, v)} />
        <SelectField id="order-priority" label="Priority" value={priority} onChange={(v) => changed(setPriority, v)} options={[{ value: 'Low', label: 'Low' }, { value: 'Normal', label: 'Normal' }, { value: 'High', label: 'High' }, { value: 'Urgent', label: 'Urgent' }]} />
        <SelectField id="order-delivery" label="Delivery method" value={deliveryMethod} onChange={(v) => changed(setDeliveryMethod, v)} options={[{ value: 'Collection', label: 'Collection' }, { value: 'Delivery', label: 'Delivery' }]} />
      </div>
      {deliveryMethod === 'Delivery' && <Field id="order-address" label="Delivery address" required maxLength={500} value={deliveryAddress} onChange={(v) => changed(setDeliveryAddress, v)} />}
      <TextAreaField id="order-delivery-instructions" label="Delivery instructions" maxLength={1000} value={deliveryInstructions} onChange={(v) => changed(setDeliveryInstructions, v)} />
      <TextAreaField id="order-notes" label="Order notes" maxLength={4000} value={notes} onChange={(v) => changed(setNotes, v)} />
      <section className="ap-stack" aria-label="Garments">
        <div className="ap-row"><h3 className="ap-h2">Garments</h3><button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => { setIdempotencyKey(null); setGarments((current) => [...current, blankGarment()]); }}>Add garment</button></div>
        {garments.map((g, i) => (
          <fieldset key={g.id ?? `new-${i}`} className="ap-fieldset ap-stack">
            <legend>Garment {i + 1}</legend>
            <div className="ap-grid2">
              <Field id={`garment-${i}-name`} label="Garment name" required maxLength={120} value={g.name} onChange={(v) => updateGarment(i, { name: v })} />
              <Field id={`garment-${i}-category`} label="Category" maxLength={80} value={g.category} onChange={(v) => updateGarment(i, { category: v })} />
              <Field id={`garment-${i}-quantity`} label="Quantity" type="number" min="1" max="10000" step="1" required value={g.quantity} onChange={(v) => updateGarment(i, { quantity: v })} />
              <Field id={`garment-${i}-price`} label="Unit price" type="number" min="0" max="100000000" step="0.01" required value={g.unitPrice} onChange={(v) => updateGarment(i, { unitPrice: v })} />
              <Field id={`garment-${i}-fabric`} label="Fabric" maxLength={120} value={g.fabric} onChange={(v) => updateGarment(i, { fabric: v })} />
              <Field id={`garment-${i}-colour`} label="Colour" maxLength={60} value={g.colour} onChange={(v) => updateGarment(i, { colour: v })} />
            </div>
            <TextAreaField id={`garment-${i}-style`} label="Style instructions" maxLength={4000} value={g.styleInstructions} onChange={(v) => updateGarment(i, { styleInstructions: v })} />
            <TextAreaField id={`garment-${i}-alteration`} label="Alteration notes" maxLength={2000} value={g.alterationNotes} onChange={(v) => updateGarment(i, { alterationNotes: v })} />
            {garments.length > 1 && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => { setIdempotencyKey(null); setGarments((current) => current.filter((_, index) => index !== i)); }}>Remove garment</button>}
          </fieldset>
        ))}
      </section>
      <Field id="order-discount" label="Discount" type="number" min="0" max="100000000" step="0.01" value={discount} onChange={(v) => changed(setDiscount, v)} />
      <p className="ap-hint">Totals are calculated by Avzar on the server. Unit prices entered here are manual prices; pricing costs and margins are not exposed by this form.</p>
      <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
        <button className="ap-btn" type="submit" disabled={busy || !locations.length || (!order && !customers.length && !customerResults?.length)}>{busy ? (amend ? 'Checking…' : 'Saving…') : amend ? 'Review changes' : order ? 'Save changes' : 'Create draft order'}</button>
        <Link href={order ? `/orders/${order.id}` : '/orders'} className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Cancel</Link>
      </div>
      {!locations.length && <p role="alert" className="ap-alert">No active workshop locations are available. Ask an administrator to check your location access.</p>}
      {!order && !customers.length && !customerResults?.length && <p className="ap-hint">No active customers are available in the initial list. Search by name, email or phone, or create a customer first.</p>}
    </form>
  );
}
