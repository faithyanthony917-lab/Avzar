'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { Pager, usePaged } from './Pager';
import { toast } from '@/lib/toast';

export type Supplier = {
  Id: string; Name: string; ContactName: string | null; Email: string | null; Phone: string | null;
  Address: string | null; Notes: string | null; IsActive: boolean;
};

const EMPTY = { name: '', contactName: '', email: '', phone: '', address: '', notes: '' };
const blank = (value: string) => (value.trim() === '' ? null : value.trim());

export function SupplierManager({ canManage }: { canManage: boolean }) {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  
  const load = useCallback(async () => {
    setLoadError('');
    try { setSuppliers(await api<Supplier[]>('/api/suppliers')); }
    catch (err) { setLoadError(messageFor(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = (key: keyof typeof EMPTY) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((cur) => ({ ...cur, [key]: event.target.value }));

  function startEdit(supplier: Supplier) {
    setEditingId(supplier.Id); setError('');
    setForm({ name: supplier.Name, contactName: supplier.ContactName ?? '', email: supplier.Email ?? '', phone: supplier.Phone ?? '', address: supplier.Address ?? '', notes: supplier.Notes ?? '' });
  }
  function reset() { setEditingId(null); setForm(EMPTY); setError(''); }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    if (!form.name.trim()) { setError('Enter the supplier name.'); return; }
    if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) { setError('Enter a valid email address or leave it blank.'); return; }
    const body = { name: form.name.trim(), contactName: blank(form.contactName), email: blank(form.email), phone: blank(form.phone), address: blank(form.address), notes: blank(form.notes) };
    setSaving(true);
    try {
      if (editingId) await api(`/api/suppliers/${editingId}`, { method: 'PATCH', json: body });
      else await api('/api/suppliers', { method: 'POST', json: body });
      toast.success(editingId ? 'Supplier updated.' : 'Supplier added.');
      reset(); await load();
    } catch (err) { toast.error(messageFor(err)); }
    finally { setSaving(false); }
  }

  async function setActive(supplier: Supplier, isActive: boolean) {
    setError('');
    try {
      await api(`/api/suppliers/${supplier.Id}`, { method: 'PATCH', json: { isActive } });
      toast.success(isActive ? 'Supplier reactivated.' : 'Supplier deactivated.');
      await load();
    } catch (err) { toast.error(messageFor(err)); }
  }

  const visible = (suppliers ?? []).filter((s) => showInactive || s.IsActive);
  const paged = usePaged(visible);

  return <section className="ap-stack" aria-label="Suppliers">
    {loadError && <div role="alert" className="ap-alert"><p>{loadError}</p><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Retry loading suppliers</button></div>}
    {suppliers === null && !loadError && <p className="ap-foot" aria-live="polite">Loading suppliers…</p>}
    {suppliers && <label className="ap-row" htmlFor="supplier-show-inactive"><input id="supplier-show-inactive" type="checkbox" checked={showInactive} onChange={(event) => { setShowInactive(event.target.checked); paged.setPage(1); }} /><span>Show inactive suppliers</span></label>}
    {suppliers && visible.length === 0 && <p className="ap-hint">{suppliers.length === 0 ? 'No suppliers yet.' : 'No active suppliers. Tick “Show inactive suppliers” to see the rest.'}</p>}
    {paged.slice.map((supplier) => <article key={supplier.Id} className="ap-panel ap-stack">
      <div className="ap-row"><strong>{supplier.Name}</strong>{!supplier.IsActive && <span className="ap-badge">Inactive</span>}</div>
      {(supplier.ContactName || supplier.Phone || supplier.Email) && <p className="ap-foot">{[supplier.ContactName, supplier.Phone, supplier.Email].filter(Boolean).join(' · ')}</p>}
      {supplier.Address && <p className="ap-foot">{supplier.Address}</p>}
      {supplier.Notes && <p className="ap-pre">{supplier.Notes}</p>}
      {canManage && <div className="ap-actions">
        <button type="button" className="ap-btn ap-btn-quiet" onClick={() => startEdit(supplier)}>Edit {supplier.Name}</button>
        <button type="button" className="ap-btn ap-btn-quiet" onClick={() => void setActive(supplier, !supplier.IsActive)}>{supplier.IsActive ? 'Deactivate' : 'Reactivate'} {supplier.Name}</button>
      </div>}
    </article>)}
    <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Suppliers pages" />
    {canManage && <form className="ap-stack" onSubmit={(event) => void save(event)} noValidate>
      <h2 className="ap-h2">{editingId ? 'Edit supplier' : 'Add a supplier'}</h2>
      <div className="ap-field"><label htmlFor="supplier-name">Name</label><input id="supplier-name" value={form.name} onChange={set('name')} maxLength={160} disabled={saving} /></div>
      <div className="ap-field"><label htmlFor="supplier-contact">Contact person</label><input id="supplier-contact" value={form.contactName} onChange={set('contactName')} maxLength={80} disabled={saving} /></div>
      <div className="ap-field"><label htmlFor="supplier-phone">Phone</label><input id="supplier-phone" type="tel" value={form.phone} onChange={set('phone')} maxLength={40} disabled={saving} /></div>
      <div className="ap-field"><label htmlFor="supplier-email">Email</label><input id="supplier-email" type="email" value={form.email} onChange={set('email')} maxLength={254} disabled={saving} /></div>
      <div className="ap-field"><label htmlFor="supplier-address">Address</label><input id="supplier-address" value={form.address} onChange={set('address')} maxLength={500} disabled={saving} /></div>
      <label className="ap-stack" htmlFor="supplier-notes"><span>Notes</span><textarea id="supplier-notes" className="ap-input" rows={2} maxLength={2000} value={form.notes} onChange={set('notes')} disabled={saving} /></label>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <div className="ap-actions">
        <button type="submit" className="ap-btn" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save supplier' : 'Add supplier'}</button>
        {editingId && <button type="button" className="ap-btn ap-btn-quiet" onClick={reset} disabled={saving}>Cancel editing</button>}
      </div>
    </form>}
    {!canManage && error && <p role="alert" className="ap-alert">{error}</p>}
  </section>;
}
