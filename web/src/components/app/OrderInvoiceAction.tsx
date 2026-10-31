'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import type { Invoice } from '@/lib/finance-types';

export function OrderInvoiceAction({ orderId, orderStatus, canManage }: { orderId: string; orderStatus: string; canManage: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState('Full');
  const [depositPercent, setDepositPercent] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const eligible = ['Confirmed', 'InProduction', 'Ready'].includes(orderStatus);
  if (!canManage || !eligible) return null;

  async function createInvoice() {
    if (mode === 'Deposit' && !depositPercent && !depositAmount) { setError('Enter either a deposit percentage or a deposit amount.'); return; }
    if (depositPercent && depositAmount) { setError('Choose a deposit percentage or a deposit amount, not both.'); return; }
    setBusy(true); setError('');
    try {
      const key = idempotencyKey ?? crypto.randomUUID(); setIdempotencyKey(key);
      const invoice = await api<Invoice>(`/api/invoices/from-order/${orderId}`, { method: 'POST', idempotencyKey: key, json: { mode, depositPercent: mode === 'Deposit' && depositPercent ? Number(depositPercent) : null, depositAmount: mode === 'Deposit' && depositAmount ? Number(depositAmount) : null, dueDate: dueDate || null, taxPercent: null, notes: null, terms: null } });
      router.push(`/finance/invoices/${invoice.id}`); router.refresh();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }
  return <section className="ap-panel ap-stack"><h2 className="ap-h2">Invoice this order</h2><p className="ap-foot" style={{ margin: 0 }}>Create a draft invoice for the full order, a deposit, or the unbilled balance. The API checks what has already been billed.</p>{error && <p className="ap-alert" role="alert">{error}</p>}<div className="ap-grid2"><div className="ap-field"><label htmlFor="order-invoice-mode">Invoice type</label><select id="order-invoice-mode" className="ap-input" value={mode} disabled={busy} onChange={(e) => { setIdempotencyKey(null); setMode(e.target.value); }}><option value="Full">Full order</option><option value="Deposit">Deposit</option><option value="Balance">Remaining balance</option></select></div><div className="ap-field"><label htmlFor="order-invoice-due">Due date</label><input id="order-invoice-due" type="date" className="ap-input" value={dueDate} disabled={busy} onChange={(e) => { setIdempotencyKey(null); setDueDate(e.target.value); }} /></div>{mode === 'Deposit' && <><div className="ap-field"><label htmlFor="order-deposit-percent">Deposit percentage (%)</label><input id="order-deposit-percent" type="number" min="0.01" max="99.99" step="0.01" className="ap-input" value={depositPercent} disabled={busy} onChange={(e) => { setIdempotencyKey(null); setDepositPercent(e.target.value); }} /></div><div className="ap-field"><label htmlFor="order-deposit-amount">Or deposit amount</label><input id="order-deposit-amount" type="number" min="0.01" step="0.01" className="ap-input" value={depositAmount} disabled={busy} onChange={(e) => { setIdempotencyKey(null); setDepositAmount(e.target.value); }} /></div></>}</div><button className="ap-btn" disabled={busy || (mode === 'Deposit' && ((!depositPercent && !depositAmount) || (!!depositPercent && !!depositAmount)))} onClick={() => void createInvoice()}>{busy ? 'Creating…' : 'Create draft invoice'}</button></section>;
}
