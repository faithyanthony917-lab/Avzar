'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import type { Invoice } from '@/lib/finance-types';

type EditableLine = { description: string; quantity: string; unitPrice: string; discount: string; taxPercent: string };

function lineFromInvoice(line: Invoice['lines'][number]): EditableLine {
  return {
    description: line.description,
    quantity: String(line.quantity),
    unitPrice: String(line.unitPrice),
    discount: String(line.discount),
    taxPercent: String(line.taxPercent),
  };
}

const emptyLine = (): EditableLine => ({ description: '', quantity: '1', unitPrice: '0', discount: '0', taxPercent: '0' });

export function InvoiceDraftEditor({ invoice, onSaved }: { invoice: Invoice; onSaved: () => Promise<void> }) {
  const [dueDate, setDueDate] = useState(invoice.dueDate ?? '');
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [terms, setTerms] = useState(invoice.terms ?? '');
  const [lines, setLines] = useState<EditableLine[]>(invoice.lines.map(lineFromInvoice));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEditLines = !invoice.orderId;

  function updateLine(index: number, key: keyof EditableLine, value: string) {
    setLines(current => current.map((line, i) => i === index ? { ...line, [key]: value } : line));
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const payload = {
        version: invoice.version,
        dueDate: dueDate || null,
        notes: notes.trim() || null,
        terms: terms.trim() || null,
        ...(canEditLines ? { lines: lines.map(line => ({
          description: line.description.trim(),
          quantity: Number(line.quantity),
          unitPrice: Number(line.unitPrice),
          discount: Number(line.discount),
          taxPercent: Number(line.taxPercent),
        })) } : {}),
      };
      if (canEditLines && (!lines.length || lines.some(line => !line.description.trim() || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0 || !Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0 || !Number.isFinite(Number(line.discount)) || Number(line.discount) < 0 || !Number.isFinite(Number(line.taxPercent)) || Number(line.taxPercent) < 0 || Number(line.taxPercent) > 100))) {
        setError('Check every line: description is required, quantity must be positive, prices and discounts cannot be negative, and tax must be 0–100%.');
        return;
      }
      await api(`/api/invoices/${invoice.id}`, { method: 'PUT', json: payload });
      await onSaved();
      toast.success('Draft invoice saved.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return <section className="ap-panel ap-stack">
    <h2 className="ap-h2">Edit draft invoice</h2>
    {invoice.orderId && <p className="ap-foot">This invoice was generated from an order. Its line items are locked; you can still edit the due date, notes, and terms.</p>}
    {error && <p className="ap-alert" role="alert">{error}</p>}
    <form className="ap-stack" onSubmit={save}>
      <div className="ap-grid2">
        <div className="ap-field"><label htmlFor="draft-invoice-due-date">Due date</label><input id="draft-invoice-due-date" type="date" className="ap-input" value={dueDate} disabled={busy} onChange={e => setDueDate(e.target.value)} /></div>
      </div>
      {canEditLines && <div className="ap-stack">
        <div className="ap-row"><h3 className="ap-h3">Line items</h3><button type="button" className="ap-btn ap-btn-quiet" disabled={busy || lines.length >= 100} onClick={() => setLines(current => [...current, emptyLine()])}>Add line</button></div>
        {lines.map((line, index) => <fieldset key={index} className="ap-panel ap-stack" style={{ minWidth: 0 }}>
          <legend>Line {index + 1}</legend>
          <div className="ap-field"><label htmlFor={`draft-line-description-${index}`}>Description</label><input id={`draft-line-description-${index}`} className="ap-input" maxLength={200} required value={line.description} disabled={busy} onChange={e => updateLine(index, 'description', e.target.value)} /></div>
          <div className="ap-grid2">
            <div className="ap-field"><label htmlFor={`draft-line-quantity-${index}`}>Quantity</label><input id={`draft-line-quantity-${index}`} type="number" min="0.01" step="0.01" className="ap-input" required value={line.quantity} disabled={busy} onChange={e => updateLine(index, 'quantity', e.target.value)} /></div>
            <div className="ap-field"><label htmlFor={`draft-line-price-${index}`}>Unit price ({invoice.currencyCode})</label><input id={`draft-line-price-${index}`} type="number" min="0" step="0.01" className="ap-input" required value={line.unitPrice} disabled={busy} onChange={e => updateLine(index, 'unitPrice', e.target.value)} /></div>
            <div className="ap-field"><label htmlFor={`draft-line-discount-${index}`}>Discount ({invoice.currencyCode})</label><input id={`draft-line-discount-${index}`} type="number" min="0" step="0.01" className="ap-input" required value={line.discount} disabled={busy} onChange={e => updateLine(index, 'discount', e.target.value)} /></div>
            <div className="ap-field"><label htmlFor={`draft-line-tax-${index}`}>Tax (%)</label><input id={`draft-line-tax-${index}`} type="number" min="0" max="100" step="0.01" className="ap-input" required value={line.taxPercent} disabled={busy} onChange={e => updateLine(index, 'taxPercent', e.target.value)} /></div>
          </div>
          <div className="ap-actions"><button type="button" className="ap-btn ap-btn-danger ap-btn-sm" disabled={busy || lines.length <= 1} onClick={() => setLines(current => current.filter((_, i) => i !== index))}>Remove line</button></div>
        </fieldset>)}
      </div>}
      <div className="ap-field"><label htmlFor="draft-invoice-notes">Notes</label><textarea id="draft-invoice-notes" className="ap-input" rows={3} maxLength={2000} value={notes} disabled={busy} onChange={e => setNotes(e.target.value)} /></div>
      <div className="ap-field"><label htmlFor="draft-invoice-terms">Terms</label><textarea id="draft-invoice-terms" className="ap-input" rows={3} maxLength={2000} value={terms} disabled={busy} onChange={e => setTerms(e.target.value)} /></div>
      <div className="ap-actions"><button className="ap-btn" disabled={busy}>{busy ? 'Saving…' : 'Save draft changes'}</button></div>
    </form>
  </section>;
}
