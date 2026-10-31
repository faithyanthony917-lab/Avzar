'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { CustomerSummary } from '@/lib/customer-types';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import type { Invoice } from '@/lib/finance-types';
import { Field, TextAreaField } from './Field';

type LineDraft = { description: string; quantity: string; unitPrice: string; discount: string; taxPercent: string };
const blankLine = (): LineDraft => ({ description: '', quantity: '1', unitPrice: '0', discount: '0', taxPercent: '' });
const nullable = (value: string) => value.trim() || null;

export function CreateInvoiceForm({ customers }: { customers: CustomerSummary[] }) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [taxPercent, setTaxPercent] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  function change<T>(setter: (value: T) => void, value: T) { setIdempotencyKey(null); setter(value); }

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setIdempotencyKey(null); setLines((old) => old.map((line, i) => i === index ? { ...line, ...patch } : line));
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    if (!customerId) { setError('Choose a customer.'); return; }
    if (!lines.length || lines.some((l) => !l.description.trim() || !Number.isFinite(Number(l.quantity)) || Number(l.quantity) <= 0 || !Number.isFinite(Number(l.unitPrice)) || Number(l.unitPrice) < 0 || !Number.isFinite(Number(l.discount)) || Number(l.discount) < 0 || (l.taxPercent !== '' && (!Number.isFinite(Number(l.taxPercent)) || Number(l.taxPercent) < 0 || Number(l.taxPercent) > 100)))) {
      setError('Each line needs a description, positive quantity, valid unit price/discount, and tax between 0 and 100 if supplied.'); return;
    }
    if (taxPercent !== '' && (!Number.isFinite(Number(taxPercent)) || Number(taxPercent) < 0 || Number(taxPercent) > 100)) { setError('Default tax must be between 0 and 100.'); return; }
    setBusy(true);
    try {
      const key = idempotencyKey ?? crypto.randomUUID(); setIdempotencyKey(key);
      const invoice = await api<Invoice>('/api/invoices', { method: 'POST', idempotencyKey: key, json: {
        customerId, dueDate: dueDate || null, taxPercent: taxPercent === '' ? null : Number(taxPercent), notes: nullable(notes), terms: nullable(terms),
        lines: lines.map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discount: Number(l.discount), taxPercent: l.taxPercent === '' ? null : Number(l.taxPercent) })),
      } });
      router.push(`/finance/invoices/${invoice.id}`); router.refresh();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy}>
    <div><h1 style={{ marginBottom: '.25rem' }}>New invoice</h1><p className="ap-foot" style={{ margin: 0 }}>Create a draft invoice for services or work not automatically billed from an order. Avzar calculates the final totals on the server.</p></div>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    <div className="ap-field"><label htmlFor="invoice-customer">Customer</label><select id="invoice-customer" className="ap-input" value={customerId} required disabled={busy} onChange={(e) => change(setCustomerId, e.target.value)}><option value="">Choose an active customer</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.fullName}{c.phone ? ` · ${c.phone}` : ''}</option>)}</select>{customers.length === 0 && <p className="ap-err">No active customers available. Create or reactivate a customer first.</p>}</div>
    <div className="ap-grid2"><Field id="invoice-due-date" label="Due date" type="date" value={dueDate} onChange={(v) => change(setDueDate, v)} /><Field id="invoice-tax" label="Default tax (%)" type="number" min="0" max="100" step="0.01" value={taxPercent} onChange={(v) => change(setTaxPercent, v)} /></div>
    <section className="ap-stack"><div className="ap-row"><h2 className="ap-h2">Invoice lines</h2><button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy || lines.length >= 100} onClick={() => { setIdempotencyKey(null); setLines((old) => [...old, blankLine()]); }}>Add line</button></div>{lines.map((line, i) => <fieldset key={i} className="ap-fieldset ap-stack"><legend>Line {i + 1}</legend><Field id={`line-${i}-description`} label="Description" required maxLength={200} value={line.description} onChange={(v) => updateLine(i, { description: v })} /><div className="ap-grid2"><Field id={`line-${i}-quantity`} label="Quantity" type="number" min="0.01" max="100000" step="0.01" required value={line.quantity} onChange={(v) => updateLine(i, { quantity: v })} /><Field id={`line-${i}-price`} label="Unit price" type="number" min="0" max="1000000000" step="0.01" required value={line.unitPrice} onChange={(v) => updateLine(i, { unitPrice: v })} /><Field id={`line-${i}-discount`} label="Discount amount" type="number" min="0" max="1000000000" step="0.01" value={line.discount} onChange={(v) => updateLine(i, { discount: v })} /><Field id={`line-${i}-tax`} label="Tax override (%) · optional" type="number" min="0" max="100" step="0.01" value={line.taxPercent} onChange={(v) => updateLine(i, { taxPercent: v })} /></div>{lines.length > 1 && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={() => { setIdempotencyKey(null); setLines((old) => old.filter((_, index) => index !== i)); }}>Remove line</button>}</fieldset>)}</section>
    <TextAreaField id="invoice-notes" label="Notes" maxLength={2000} value={notes} onChange={(v) => change(setNotes, v)} /><TextAreaField id="invoice-terms" label="Terms" maxLength={2000} value={terms} onChange={(v) => change(setTerms, v)} />
    <p className="ap-hint">Creating this invoice only creates a draft. Review it and issue it before recording payments. Payments remain pending until verified by an authorized user.</p>
    <div className="ap-actions"><button className="ap-btn" disabled={busy || customers.length === 0}>{busy ? 'Creating…' : 'Create draft invoice'}</button><Link className="ap-btn ap-btn-quiet" href="/finance" style={{ textDecoration: 'none' }}>Cancel</Link></div>
  </form>;
}
