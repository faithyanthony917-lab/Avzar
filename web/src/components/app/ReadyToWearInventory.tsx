'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { Pager, usePaged } from './Pager';
import { toast } from '@/lib/toast';

type Design = { id: string; name: string; basePrice: number | null; currencyCode: string | null; visibility: string };
type Variant = { id: string; designId: string; productName: string; sku: string; size: string | null; colour: string | null; onHand: number; reserved: number; available: number; isActive: boolean; price: number | null; currencyCode: string | null };

export function ReadyToWearInventory({ designs, variants }: { designs: Design[]; variants: Variant[] }) {
  const router = useRouter();
  const paged = usePaged(variants);
  const [designId, setDesignId] = useState(designs[0]?.id ?? '');
  const [sku, setSku] = useState(''); const [size, setSize] = useState(''); const [colour, setColour] = useState(''); const [onHand, setOnHand] = useState('0');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');   async function add() {
    if (!designId || !sku.trim() || !/^(0|[1-9]\d*)$/.test(onHand) || Number(onHand) > 1_000_000) { setError('Choose a product, enter a SKU, and enter a whole-number stock quantity.'); return; }
    setBusy(true); setError('');
    try {
      await api('/api/ready-to-wear/variants', { method: 'POST', json: { designId, sku: sku.trim(), size: size.trim() || null, colour: colour.trim() || null, onHand: Number(onHand), isActive: true } });
      setSku(''); setSize(''); setColour(''); setOnHand('0'); toast.success('Stock variant added.'); router.refresh();
    } catch (e) { toast.error(messageFor(e)); } finally { setBusy(false); }
  }
  async function saveStock(v: Variant, raw: string) {
    if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > 1_000_000) { setError('Stock must be a whole number from 0 to 1,000,000.'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/ready-to-wear/variants/${encodeURIComponent(v.id)}`, { method: 'PUT', json: { designId: v.designId, sku: v.sku, size: v.size, colour: v.colour, onHand: Number(raw), isActive: v.isActive } });
      toast.success(`Stock updated for ${v.sku}.`); router.refresh();
    } catch (e) { toast.error(messageFor(e)); } finally { setBusy(false); }
  }
  return <div className="ap-stack">
    {error && <p className="ap-alert" role="alert">{error}</p>}
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Add size / colour stock</h2><p className="ap-foot">First create a product under Designs and set its price. Each SKU is a separately reserved stock variant.</p>
      {designs.length === 0 ? <p>No active Ready-made designs found. Create one in Designs first.</p> : <>
        <div className="ap-field"><label htmlFor="rtw-design">Product</label><select id="rtw-design" className="ap-input" value={designId} disabled={busy} onChange={(e) => setDesignId(e.target.value)}>{designs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.basePrice == null ? 'No price' : `${d.currencyCode ? `${d.currencyCode} ` : ''}${d.basePrice}`}</option>)}</select></div>
        <div className="ap-grid2"><div className="ap-field"><label htmlFor="rtw-sku">SKU</label><input id="rtw-sku" className="ap-input" maxLength={80} value={sku} disabled={busy} onChange={(e) => setSku(e.target.value)} /></div><div className="ap-field"><label htmlFor="rtw-size">Size</label><input id="rtw-size" className="ap-input" maxLength={40} value={size} disabled={busy} onChange={(e) => setSize(e.target.value)} placeholder="e.g. M" /></div><div className="ap-field"><label htmlFor="rtw-colour">Colour</label><input id="rtw-colour" className="ap-input" maxLength={60} value={colour} disabled={busy} onChange={(e) => setColour(e.target.value)} placeholder="e.g. Black" /></div><div className="ap-field"><label htmlFor="rtw-stock">On hand</label><input id="rtw-stock" className="ap-input" type="number" min="0" max="1000000" step="1" value={onHand} disabled={busy} onChange={(e) => setOnHand(e.target.value)} /></div></div>
        <button type="button" className="ap-btn" disabled={busy} onClick={() => void add()}>{busy ? 'Saving…' : 'Add stock variant'}</button>
      </>}
    </section>
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Current ready-to-wear stock</h2>{variants.length === 0 ? <p>No stock variants yet.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Product / SKU</th><th>Variant</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Update stock</th></tr></thead><tbody>{paged.slice.map((v) => <VariantRow key={v.id} variant={v} disabled={busy} onSave={saveStock} />)}</tbody></table></div>}<Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Stock variants pages" /></section>
  </div>;
}

function VariantRow({ variant, disabled, onSave }: { variant: Variant; disabled: boolean; onSave: (variant: Variant, quantity: string) => Promise<void> }) {
  const [quantity, setQuantity] = useState(String(variant.onHand));
  return <tr><td>{variant.productName}<div className="ap-foot">{variant.sku}{!variant.isActive ? ' · inactive' : ''}</div></td><td>{[variant.size,variant.colour].filter(Boolean).join(' / ') || 'Standard'}</td><td><input aria-label={`On hand for ${variant.sku}`} className="ap-input" type="number" min={variant.reserved} max="1000000" step="1" value={quantity} disabled={disabled} onChange={(e) => setQuantity(e.target.value)} /></td><td>{variant.reserved}</td><td>{variant.available}</td><td><button className="ap-btn ap-btn-quiet" type="button" disabled={disabled || quantity === String(variant.onHand)} onClick={() => void onSave(variant, quantity)}>Save</button></td></tr>;
}
