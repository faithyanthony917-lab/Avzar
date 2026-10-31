'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { money, type Paged } from '@/lib/finance-types';
import { Pager } from './Pager';
import { toast } from '@/lib/toast';

type Category = { id: string; name: string; isActive: boolean; sortOrder: number };
type Expense = { id: string; categoryId: string; categoryName: string; expenseDate: string; amount: number; currencyCode: string; description: string; vendor: string | null; reference: string | null; isVoid: boolean; voidReason: string | null; version: number; locationId: string | null };
const today = () => new Date().toISOString().slice(0, 10);

export function ExpenseManager({ canManage }: { canManage: boolean }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenses, setExpenses] = useState<Paged<Expense> | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryActive, setCategoryActive] = useState(true);
  const [categoryId, setCategoryId] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [reference, setReference] = useState('');
  const [editing, setEditing] = useState<Expense | null>(null);
  const [search, setSearch] = useState('');
  const [expPage, setExpPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  
  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [c, e] = await Promise.all([
        api<Category[]>('/api/expense-categories'),
        api<Paged<Expense>>(`/api/expenses?page=${expPage}&pageSize=10${search.trim() ? `&search=${encodeURIComponent(search.trim().slice(0, 100))}` : ''}&includeVoid=true`),
      ]);
      setCategories(c); setExpenses(e);
      if (!categoryId && c.length) setCategoryId(c.find((x) => x.isActive)?.id ?? c[0]!.id);
    } catch (ex) { setError(messageFor(ex)); }
    finally { setBusy(false); }
  }, [search, categoryId, expPage]);
  useEffect(() => { void refresh(); }, [refresh]);

  function resetForm() { setEditing(null); setDate(today()); setAmount(''); setDescription(''); setVendor(''); setReference(''); setCategoryId(categories.find((c) => c.isActive)?.id ?? ''); }
  function editExpense(e: Expense) { setEditing(e); setDate(e.expenseDate); setAmount(String(e.amount)); setDescription(e.description); setVendor(e.vendor ?? ''); setReference(e.reference ?? ''); setCategoryId(e.categoryId); }

  async function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const payload = { categoryId, expenseDate: date, amount: Number(amount), description: description.trim(), vendor: vendor.trim() || null, reference: reference.trim() || null, ...(editing ? { version: editing.version, locationId: editing.locationId } : {}) };
      await api(editing ? `/api/expenses/${editing.id}` : '/api/expenses', { method: editing ? 'PUT' : 'POST', json: payload });
      toast.success(editing ? 'Expense updated.' : 'Expense recorded.'); resetForm(); await refresh();
    } catch (ex) { toast.error(messageFor(ex)); }
    finally { setBusy(false); }
  }
  async function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const existing = categories.find((c) => c.name.toLocaleLowerCase() === categoryName.trim().toLocaleLowerCase());
      if (existing) await api(`/api/expense-categories/${existing.id}`, { method: 'PUT', json: { name: categoryName.trim(), isActive: categoryActive, sortOrder: existing.sortOrder } });
      else await api('/api/expense-categories', { method: 'POST', json: { name: categoryName.trim(), isActive: categoryActive, sortOrder: categories.length } });
      setCategoryName(''); setCategoryActive(true); toast.success(existing ? 'Category updated.' : 'Category created.'); await refresh();
    } catch (ex) { toast.error(messageFor(ex)); }
    finally { setBusy(false); }
  }
  async function voidExpense(e: Expense) {
    const reason = window.prompt(`Why are you voiding this expense?`);
    if (!reason?.trim()) return;
    setBusy(true); setError('');
    try { await api(`/api/expenses/${e.id}/void`, { method: 'POST', json: { reason: reason.trim() } }); toast.success('Expense voided; it remains in the audit history.'); await refresh(); }
    catch (ex) { toast.error(messageFor(ex)); }
    finally { setBusy(false); }
  }

  return <section className="ap-panel ap-stack">
    <div><h2 className="ap-h2">Expenses</h2><p className="ap-foot" style={{ margin: '.25rem 0 0' }}>Record and edit expenses, manage categories, and void incorrect entries without deleting the audit history.</p></div>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    {canManage && <form className="ap-stack" onSubmit={(e) => void saveExpense(e)}>
      <h3 className="ap-h3">{editing ? 'Edit expense' : 'Record expense'}</h3>
      <div className="ap-grid2">
        <div className="ap-field"><label htmlFor="expense-category">Category</label><select id="expense-category" className="ap-input" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={busy || !categories.some((c) => c.isActive)}><option value="">Choose category</option>{categories.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="ap-field"><label htmlFor="expense-date">Date</label><input id="expense-date" className="ap-input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} /></div>
        <div className="ap-field"><label htmlFor="expense-amount">Amount</label><input id="expense-amount" className="ap-input" type="number" min="0.01" max="1000000000" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></div>
        <div className="ap-field"><label htmlFor="expense-vendor">Vendor (optional)</label><input id="expense-vendor" className="ap-input" maxLength={120} value={vendor} onChange={(e) => setVendor(e.target.value)} disabled={busy} /></div>
        <div className="ap-field"><label htmlFor="expense-reference">Reference (optional)</label><input id="expense-reference" className="ap-input" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} disabled={busy} /></div>
        <div className="ap-field"><label htmlFor="expense-description">Description</label><input id="expense-description" className="ap-input" minLength={2} maxLength={300} required value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} /></div>
      </div>
      <div className="ap-actions"><button className="ap-btn" disabled={busy || !categoryId}>{editing ? 'Save changes' : 'Record expense'}</button>{editing && <button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={resetForm}>Cancel edit</button>}</div>
    </form>}
    {canManage && <form className="ap-grid2" onSubmit={(e) => void saveCategory(e)}><div className="ap-field"><label htmlFor="expense-category-name">Add or update category by name</label><input id="expense-category-name" className="ap-input" minLength={2} maxLength={80} required value={categoryName} onChange={(e) => setCategoryName(e.target.value)} disabled={busy} placeholder="e.g. Fabric and supplies" /></div><div className="ap-field"><label className="ap-check"><input type="checkbox" checked={categoryActive} onChange={(e) => setCategoryActive(e.target.checked)} disabled={busy} /> Active category</label><button className="ap-btn ap-btn-quiet" disabled={busy}>Save category</button></div></form>}
    <div className="ap-row"><h3 className="ap-h3">Expense ledger</h3><form className="ap-actions" onSubmit={(e) => { e.preventDefault(); if (expPage !== 1) setExpPage(1); else void refresh(); }}><input aria-label="Search expenses" className="ap-input" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} placeholder="Search expenses" /><button className="ap-btn ap-btn-quiet" disabled={busy}>Search</button></form></div>
    <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Vendor</th><th>Amount</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead><tbody>{expenses?.items.map((e) => <tr key={e.id}><td>{e.expenseDate}</td><td>{e.description}{e.reference && <div className="ap-foot">Ref: {e.reference}</div>}</td><td>{e.categoryName}</td><td>{e.vendor ?? '—'}</td><td>{money(e.amount, e.currencyCode)}</td><td>{e.isVoid ? `Void${e.voidReason ? `: ${e.voidReason}` : ''}` : 'Recorded'}</td>{canManage && <td><div className="ap-actions">{!e.isVoid && <><button className="ap-btn ap-btn-quiet ap-btn-sm" type="button" disabled={busy} onClick={() => editExpense(e)}>Edit</button><button className="ap-btn ap-btn-danger ap-btn-sm" type="button" disabled={busy} onClick={() => void voidExpense(e)}>Void</button></>}</div></td>}</tr>)}</tbody></table>{expenses?.items.length === 0 && <p className="ap-foot">No expenses found.</p>}</div>{expenses && <Pager page={expenses.page} pages={Math.max(1, Math.ceil(expenses.totalCount / (expenses.pageSize || 10)))} total={expenses.totalCount} size={expenses.pageSize || 10} onPage={setExpPage} label="Expenses pages" />}
  </section>;
}
