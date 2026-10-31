'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { money } from '@/lib/format';
import { messageFor } from '@/lib/problem';
import { NOTE_MAX, decisionMessage, noteProblem, normalizePortalQuotations, type PortalQuotation } from '@/lib/quotation';
import { toast } from '@/lib/toast';

/** Quotations the business sent to this customer. The portal token is the credential; it is sent in the request body and never stored. */
export function CustomerPortalQuotations({ token }: { token: string }) {
  const [quotes, setQuotes] = useState<PortalQuotation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    let alive = true;
    api<unknown>('/api/customer-portal/quotations', { method: 'POST', json: { token } })
      .then((payload) => { if (alive) setQuotes(normalizePortalQuotations(payload)); })
      .catch((e) => { if (alive) setLoadError(messageFor(e)); });
    return () => { alive = false; };
  }, [token]);

  async function answer(quote: PortalQuotation, decision: 'approve' | 'decline') {
    if (busy) return;
    const note = notes[quote.orderId] ?? '';
    const problem = noteProblem(note);
    if (problem) { setError(problem); return; }
    const total = money(quote.total, quote.currencyCode) ?? String(quote.total);
    const question = decision === 'approve' ? `Approve quotation ${quote.orderNumber} for ${total}? This cannot be changed afterwards.` : `Decline quotation ${quote.orderNumber}? This cannot be changed afterwards.`;
    if (!window.confirm(question)) return;
    setBusy(quote.orderId); setError(null);
    try {
      const result = await api<{ decision: 'Approved' | 'Declined'; decidedAtUtc: string }>('/api/customer-portal/quotations/respond', {
        method: 'POST', json: { token, orderId: quote.orderId, quotationId: quote.quotationId, decision, ...(note.trim() ? { note: note.trim() } : {}) } });
      setQuotes((current) => (current ?? []).map((q) => (q.orderId === quote.orderId ? { ...q, decision: result.decision, decidedAtUtc: result.decidedAtUtc } : q)));
      toast.success(decisionMessage(result.decision, quote.orderNumber));
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(null); }
  }

  if (loadError) return <section className="ap-panel"><p role="alert" className="ap-alert">Your quotations could not be loaded. {loadError}</p></section>;
  if (quotes === null) return <section className="ap-panel"><p className="ap-foot" aria-live="polite">Loading your quotations…</p></section>;
  if (quotes.length === 0) return null; // nothing awaiting an answer: show no empty box

  return (
    <section className="ap-panel ap-stack" aria-labelledby="portal-quotes-heading">
      <h2 id="portal-quotes-heading" className="ap-h2">Quotations for you</h2>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      {quotes.map((quote) => (
        <article key={quote.orderId} className="ap-stack" style={{ borderBottom: '1px solid var(--ap-border,#ddd)', paddingBottom: '1rem' }}>
          <div className="ap-row"><strong>{quote.orderNumber}</strong>{quote.decision && <span className="ap-badge">{quote.decision}</span>}</div>
          <p className="ap-foot">Promised date: {quote.promisedDate}</p>
          <div className="ap-scroll">
            <table className="ap-table">
              <thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
              <tbody>{quote.lines.map((line, index) => <tr key={`${line.name}-${index}`}><td>{line.name}</td><td>{line.quantity}</td><td>{money(line.unitPrice, quote.currencyCode)}</td><td>{money(line.lineTotal, quote.currencyCode)}</td></tr>)}</tbody>
            </table>
          </div>
          {quote.discount > 0 && <p className="ap-foot">Discount: {money(quote.discount, quote.currencyCode)}</p>}
          <p><strong>Total: {money(quote.total, quote.currencyCode)}</strong></p>
          {!quote.decision && (
            <>
              <div className="ap-field">
                <label htmlFor={`quote-note-${quote.orderId}`}>Message to the business (optional)</label>
                <textarea id={`quote-note-${quote.orderId}`} className="ap-input" rows={2} maxLength={NOTE_MAX} value={notes[quote.orderId] ?? ''} onChange={(e) => setNotes((current) => ({ ...current, [quote.orderId]: e.target.value }))} />
              </div>
              <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
                <button type="button" className="ap-btn" onClick={() => void answer(quote, 'approve')} disabled={busy !== null}>{busy === quote.orderId ? 'Sending…' : 'Approve quotation'}</button>
                <button type="button" className="ap-btn ap-btn-quiet" onClick={() => void answer(quote, 'decline')} disabled={busy !== null}>Decline</button>
              </div>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
