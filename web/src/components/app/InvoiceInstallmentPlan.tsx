'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { money } from '@/lib/finance-types';
import {
  customPlanProblem, installmentBadgeClass, installmentLabel, installmentMessage, type CustomRow, type InstallmentPlan,
} from '@/lib/installment-plan';
import { toast } from '@/lib/toast';

type Props = { invoiceId: string; currencyCode: string; balance: number; canMake: boolean; canView: boolean; onChanged?: () => void };
type Mode = 'equal' | 'custom';

const today = () => new Date().toISOString().slice(0, 10);

/** Invoice page section: split what is owed into dated installments. The plan never holds money; payments land on the invoice as usual. */
export function InvoiceInstallmentPlan({ invoiceId, currencyCode, balance, canMake, canView, onChanged }: Props) {
  const path = `/api/invoices/${invoiceId}/installment-plan`;
  const [plan, setPlan] = useState<InstallmentPlan | null | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<Mode>('equal');
  const [parts, setParts] = useState('3');
  const [firstDue, setFirstDue] = useState('');
  const [interval, setIntervalValue] = useState<'weekly' | 'monthly'>('monthly');
  const [rows, setRows] = useState<CustomRow[]>([{ dueDate: '', amount: '' }, { dueDate: '', amount: '' }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoadError('');
    try { setPlan((await api<{ plan: InstallmentPlan | null }>(path)).plan); }
    catch (err) { setLoadError(installmentMessage(err)); }
  }, [canView, path]);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    let json: Record<string, unknown>;
    if (mode === 'equal') {
      const count = Number(parts);
      if (!Number.isInteger(count) || count < 2 || count > 24) { setError('Use between 2 and 24 parts.'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDue)) { setError('Choose the first due date.'); return; }
      if (firstDue < today()) { setError('The first due date cannot be in the past.'); return; }
      json = { parts: count, firstDueDate: firstDue, interval };
    } else {
      const problem = customPlanProblem(rows, balance);
      if (problem) { setError(problem); return; }
      if (rows[0]!.dueDate < today()) { setError('The first due date cannot be in the past.'); return; }
      json = { installments: rows.map((row) => ({ dueDate: row.dueDate, amount: Number(row.amount) })) };
    }
    if (note.trim()) json.note = note.trim();
    setBusy(true);
    try {
      const result = await api<{ plan: InstallmentPlan; created: boolean }>(path, { method: 'POST', json });
      setPlan(result.plan);
      toast.success(result.created ? 'Payment plan saved.' : 'This invoice already had that plan.');
      onChanged?.();
    } catch (err) { toast.error(installmentMessage(err)); }
    finally { setBusy(false); }
  }

  async function cancel() {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'DELETE', json: {} });
      setPlan(null); setConfirming(false); toast.success('Payment plan cancelled. The invoice and its payments are unchanged.');
      onChanged?.();
    } catch (err) { toast.error(installmentMessage(err)); }
    finally { setBusy(false); }
  }

  const setRow = (index: number, patch: Partial<CustomRow>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  if (!canMake && !canView) return null;
  return <section className="ap-panel ap-stack" aria-labelledby="payment-plan">
    <h2 id="payment-plan" className="ap-h2">Payment plan</h2>
    {canView && (loadError ? <p className="ap-alert" role="alert">{loadError}</p>
      : plan === undefined ? <p className="ap-foot" role="status">Loading payment plan…</p>
      : plan === null ? <p className="ap-foot">No payment plan for this invoice.</p>
      : <div className="ap-stack">
        <p className="ap-foot" style={{ margin: 0 }}>
          {plan.state === 'Completed' ? 'Every installment is paid.' : `Still to pay on the plan: ${money(plan.outstanding, plan.currencyCode)}.`}
          {plan.overdueCount > 0 && ` ${plan.overdueCount} overdue.`}
        </p>
        {plan.matchesInvoice === false && plan.state !== 'Completed' && <p className="ap-alert" role="status">The invoice owes {money(plan.invoiceBalance ?? 0, plan.currencyCode)}, which is not what the schedule expects. Check the payments, or cancel this plan and make a new one.</p>}
        <div className="ap-scroll"><table className="ap-table"><thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead><tbody>
          {plan.installments.map((row) => <tr key={row.sequence}><td>{row.sequence}</td><td>{row.dueDate}</td><td>{money(row.amount, plan.currencyCode)}</td><td>{money(row.paid, plan.currencyCode)}</td>
            <td><span className={installmentBadgeClass(row)}>{installmentLabel(row)}</span></td></tr>)}
        </tbody></table></div>
        {plan.note && <p className="ap-foot" style={{ margin: 0 }}>Note: {plan.note}</p>}
        {canMake && (confirming
          ? <div className="ap-stack"><p className="ap-foot" style={{ margin: 0 }}>Cancel this plan? The invoice, its balance and its payments stay as they are.</p>
            <div className="ap-actions"><button type="button" className="ap-btn" disabled={busy} onClick={() => void cancel()}>{busy ? 'Cancelling…' : 'Yes, cancel the plan'}</button>
              <button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => setConfirming(false)}>Keep the plan</button></div></div>
          : <div className="ap-actions"><button type="button" className="ap-btn ap-btn-quiet" onClick={() => { setConfirming(true); }}>Cancel plan</button></div>)}
      </div>)}
    {error && <p className="ap-alert" role="alert">{error}</p>}
    {canMake && plan === null && balance > 0 && <form className="ap-stack" noValidate onSubmit={(e) => void create(e)}>
      <p className="ap-foot" style={{ margin: 0 }}>Split the {money(balance, currencyCode)} still owed into dated installments. A plan is only a schedule: payments are recorded on the invoice as usual, oldest installment first.</p>
      <div className="ap-field"><label htmlFor="plan-mode">Plan type</label>
        <select id="plan-mode" className="ap-input" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="equal">Equal parts</option><option value="custom">Custom amounts</option></select></div>
      {mode === 'equal' ? <>
        <div className="ap-field"><label htmlFor="plan-parts">Number of parts</label>
          <input id="plan-parts" type="number" min="2" max="24" step="1" className="ap-input" value={parts} disabled={busy} onChange={(e) => setParts(e.target.value)} /></div>
        <div className="ap-field"><label htmlFor="plan-first">First due date</label>
          <input id="plan-first" type="date" className="ap-input" value={firstDue} disabled={busy} onChange={(e) => setFirstDue(e.target.value)} /></div>
        <div className="ap-field"><label htmlFor="plan-interval">Repeats</label>
          <select id="plan-interval" className="ap-input" value={interval} disabled={busy} onChange={(e) => setIntervalValue(e.target.value as 'weekly' | 'monthly')}>
            <option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></div>
      </> : <fieldset className="ap-fieldset ap-stack"><legend>Installments (must add up to {money(balance, currencyCode)})</legend>
        {rows.map((row, index) => <div className="ap-row" key={index}>
          <label className="ap-field">Due date {index + 1}<input type="date" className="ap-input" value={row.dueDate} disabled={busy} onChange={(e) => setRow(index, { dueDate: e.target.value })} /></label>
          <label className="ap-field">Amount {index + 1}<input type="number" min="0.01" step="0.01" className="ap-input" value={row.amount} disabled={busy} onChange={(e) => setRow(index, { amount: e.target.value })} /></label>
          {rows.length > 2 && <button type="button" className="ap-btn ap-btn-sm ap-btn-quiet" disabled={busy} onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>Remove {index + 1}</button>}
        </div>)}
        {rows.length < 24 && <div className="ap-actions"><button type="button" className="ap-btn ap-btn-sm ap-btn-quiet" disabled={busy} onClick={() => setRows((current) => [...current, { dueDate: '', amount: '' }])}>Add installment</button></div>}
      </fieldset>}
      <div className="ap-field"><label htmlFor="plan-note">Note, optional</label>
        <input id="plan-note" className="ap-input" maxLength={500} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="ap-actions"><button className="ap-btn" disabled={busy}>{busy ? 'Saving…' : 'Make payment plan'}</button></div>
    </form>}
  </section>;
}
