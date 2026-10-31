'use client';

import Link from 'next/link';
import { useCallback, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { money, type Invoice, type Payment } from '@/lib/finance-types';
import { InvoiceOnlinePayment } from '@/components/app/InvoiceOnlinePayment';
import { InvoiceInstallmentPlan } from '@/components/app/InvoiceInstallmentPlan';
import { InvoiceDraftEditor } from '@/components/app/InvoiceDraftEditor';

type Permissions = { manage: boolean; recordPayment: boolean; verifyPayment: boolean; viewPayments: boolean };
export function InvoiceDetailManager({ initialInvoice, permissions }: { initialInvoice: Invoice; permissions: Permissions }) {
  const [invoice, setInvoice] = useState(initialInvoice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('BankTransfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [verifyNow, setVerifyNow] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [voidReason, setVoidReason] = useState('');

  const refresh = useCallback(async () => { const updated = await api<Invoice>(`/api/invoices/${invoice.id}`); setInvoice(updated); }, [invoice.id]);
  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError('');
    try { await action(); await refresh(); toast.success(success); }
    catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }
  async function issue() {
    if (!window.confirm('Issue this draft invoice? Its number and totals will be frozen.')) return;
    await act(() => api(`/api/invoices/${invoice.id}/issue`, { method: 'POST' }), 'Invoice issued.');
  }
  async function deleteDraft() {
    if (!window.confirm('Delete this draft invoice? This cannot be undone.')) return;
    setBusy(true); setError('');
    try { await api(`/api/invoices/${invoice.id}`, { method: 'DELETE' }); window.location.assign('/finance'); }
    catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }
  async function voidInvoice() {
    if (voidReason.trim().length < 3) { setError('Enter a void reason of at least 3 characters.'); return; }
    if (!window.confirm('Void this invoice? The API will refuse if payment or credit-note history prevents it.')) return;
    await act(() => api(`/api/invoices/${invoice.id}/void`, { method: 'POST', json: { reason: voidReason.trim() } }), 'Invoice voided.');
    setVoidReason('');
  }
  async function addCreditNote() {
    const amount = Number(creditAmount);
    if (!Number.isFinite(amount) || amount <= 0 || creditReason.trim().length < 3) { setError('Enter a positive credit amount and a reason of at least 3 characters.'); return; }
    await act(() => api(`/api/invoices/${invoice.id}/credit-notes`, { method: 'POST', json: { amount, reason: creditReason.trim() } }), 'Credit note added.');
    setCreditAmount(''); setCreditReason('');
  }
  async function recordPayment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a positive payment amount.'); return; }
    await act(() => api<Payment>(`/api/invoices/${invoice.id}/payments`, { method: 'POST', idempotencyKey: crypto.randomUUID(), json: { amount, method: paymentMethod, reference: paymentReference.trim() || null, receivedOn: receivedOn || null, notes: paymentNotes.trim() || null, verifyNow: verifyNow && permissions.verifyPayment } }), verifyNow && permissions.verifyPayment ? 'Payment recorded and submitted for verification.' : 'Payment claim recorded as pending verification.');
    setPaymentAmount(''); setPaymentReference(''); setReceivedOn(''); setPaymentNotes(''); setVerifyNow(false);
  }
  async function paymentAction(payment: Payment, action: 'verify' | 'reject' | 'reverse') {
    let json: unknown;
    if (action !== 'verify') {
      const reason = window.prompt(`${action === 'reject' ? 'Reason for rejecting' : 'Reason for reversing'} payment ${payment.reference ?? payment.id}:`);
      if (!reason || reason.trim().length < 3) return;
      json = { reason: reason.trim() };
    }
    if (!window.confirm(`${action[0]!.toUpperCase()}${action.slice(1)} this ${payment.status.toLowerCase()} payment?`)) return;
    await act(() => api(`/api/payments/${payment.id}/${action}`, { method: 'POST', ...(json === undefined ? {} : { json }) }), `Payment ${action} action completed.`);
  }

  const draft = invoice.status === 'Draft';
  const issued = invoice.status === 'Issued';
  return <div className="ap-stack">
    <div className="ap-row"><div><h1 style={{ marginBottom: '.25rem' }}>{invoice.number ?? 'Draft invoice'}</h1><p className="ap-foot" style={{ margin: 0 }}>{invoice.kind} · {invoice.status}{invoice.paymentStatus ? ` · ${invoice.paymentStatus}` : ''}</p></div><div className="ap-actions"><a className="ap-btn ap-btn-quiet" href={`/backend/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Download PDF</a>{invoice.customerId && <Link className="ap-btn ap-btn-quiet" href={`/customers/${invoice.customerId}`}>Customer</Link>}</div></div>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Invoice summary</h2><dl className="ap-dl"><dt>Customer</dt><dd>{invoice.customerName}</dd><dt>Related order</dt><dd>{invoice.orderId ? <Link href={`/orders/${invoice.orderId}`}>{invoice.orderNumber ?? 'View order'}</Link> : '—'}</dd><dt>Issue date</dt><dd>{invoice.issueDate ?? 'Not issued'}</dd><dt>Due date</dt><dd>{invoice.dueDate ?? '—'}</dd><dt>Subtotal</dt><dd>{money(invoice.subtotal, invoice.currencyCode)}</dd><dt>Tax</dt><dd>{money(invoice.taxTotal, invoice.currencyCode)}</dd><dt>Total</dt><dd><strong>{money(invoice.total, invoice.currencyCode)}</strong></dd><dt>Verified payments</dt><dd>{money(invoice.amountPaid, invoice.currencyCode)}</dd><dt>Pending payments</dt><dd>{money(invoice.amountPending, invoice.currencyCode)}</dd><dt>Credited</dt><dd>{money(invoice.amountCredited, invoice.currencyCode)}</dd><dt>Balance</dt><dd><strong>{money(invoice.balance, invoice.currencyCode)}</strong></dd>{invoice.voidReason && <><dt>Void reason</dt><dd>{invoice.voidReason}</dd></>}</dl>{invoice.notes && <div><h3 className="ap-h3">Notes</h3><p className="ap-pre">{invoice.notes}</p></div>}{invoice.terms && <div><h3 className="ap-h3">Terms</h3><p className="ap-pre">{invoice.terms}</p></div>}</section>
    {draft && permissions.manage && <InvoiceDraftEditor key={`${invoice.id}-${invoice.version}`} invoice={invoice} onSaved={refresh} />}
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Line items</h2><div className="ap-scroll"><table className="ap-table"><thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Discount</th><th>Tax</th><th>Total</th></tr></thead><tbody>{invoice.lines.map((line) => <tr key={line.id}><td>{line.lineNumber}</td><td>{line.description}</td><td>{line.quantity}</td><td>{money(line.unitPrice, invoice.currencyCode)}</td><td>{money(line.discount, invoice.currencyCode)}</td><td>{line.taxPercent}% · {money(line.taxAmount, invoice.currencyCode)}</td><td>{money(line.lineTotal, invoice.currencyCode)}</td></tr>)}</tbody></table>{invoice.lines.length === 0 && <p className="ap-foot">No line items.</p>}</div></section>
    {permissions.manage && <section className="ap-panel ap-stack"><h2 className="ap-h2">Invoice actions</h2><div className="ap-actions">{draft && <button className="ap-btn" disabled={busy} onClick={() => void issue()}>Issue invoice</button>}{draft && <button className="ap-btn ap-btn-danger" disabled={busy} onClick={() => void deleteDraft()}>Delete draft</button>}</div>{issued && <><div className="ap-field"><label htmlFor="void-reason">Void reason</label><textarea id="void-reason" className="ap-input" rows={2} maxLength={500} value={voidReason} disabled={busy} onChange={(e) => setVoidReason(e.target.value)} /></div><button className="ap-btn ap-btn-danger" disabled={busy || voidReason.trim().length < 3} onClick={() => void voidInvoice()}>Void invoice</button><div className="ap-grid2"><div className="ap-field"><label htmlFor="credit-amount">Credit note amount ({invoice.currencyCode})</label><input id="credit-amount" type="number" min="0.01" step="0.01" className="ap-input" value={creditAmount} disabled={busy} onChange={(e) => setCreditAmount(e.target.value)} /></div><div className="ap-field"><label htmlFor="credit-reason">Credit note reason</label><input id="credit-reason" className="ap-input" maxLength={500} value={creditReason} disabled={busy} onChange={(e) => setCreditReason(e.target.value)} /></div></div><button className="ap-btn ap-btn-quiet" disabled={busy || Number(creditAmount) <= 0 || creditReason.trim().length < 3} onClick={() => void addCreditNote()}>Add credit note</button></>}</section>}
    {issued && permissions.recordPayment && invoice.balance > 0 && <section className="ap-panel ap-stack"><h2 className="ap-h2">Record a payment</h2><p className="ap-foot" style={{ margin: 0 }}>This records a payment claim. It only increases the verified paid amount after an authorized user verifies it.</p><form className="ap-stack" onSubmit={(e) => void recordPayment(e)}><div className="ap-grid2"><div className="ap-field"><label htmlFor="payment-amount">Amount ({invoice.currencyCode})</label><input id="payment-amount" type="number" min="0.01" step="0.01" max={invoice.balance} className="ap-input" value={paymentAmount} required disabled={busy} onChange={(e) => setPaymentAmount(e.target.value)} /></div><div className="ap-field"><label htmlFor="payment-method">Method</label><select id="payment-method" className="ap-input" value={paymentMethod} disabled={busy} onChange={(e) => setPaymentMethod(e.target.value)}><option value="BankTransfer">Bank transfer</option><option value="Cash">Cash</option><option value="Card">Card</option><option value="MobileMoney">Mobile money</option><option value="Other">Other</option></select></div><div className="ap-field"><label htmlFor="payment-reference">Reference</label><input id="payment-reference" className="ap-input" maxLength={100} value={paymentReference} disabled={busy} onChange={(e) => setPaymentReference(e.target.value)} /></div><div className="ap-field"><label htmlFor="received-on">Received date</label><input id="received-on" type="date" className="ap-input" value={receivedOn} disabled={busy} onChange={(e) => setReceivedOn(e.target.value)} /></div></div><div className="ap-field"><label htmlFor="payment-notes">Notes</label><textarea id="payment-notes" className="ap-input" rows={2} maxLength={500} value={paymentNotes} disabled={busy} onChange={(e) => setPaymentNotes(e.target.value)} /></div>{permissions.verifyPayment && <label className="ap-check"><input type="checkbox" checked={verifyNow} disabled={busy} onChange={(e) => setVerifyNow(e.target.checked)} /> Verify immediately (only if the money is already confirmed)</label>}<button className="ap-btn" disabled={busy || !paymentAmount || Number(paymentAmount) <= 0}>Record payment</button></form></section>}
    {issued && invoice.balance > 0 && (permissions.recordPayment || permissions.viewPayments) && <InvoiceOnlinePayment invoiceId={invoice.id} currencyCode={invoice.currencyCode} balance={invoice.balance} canStart={permissions.recordPayment} canView={permissions.viewPayments} />}
    {issued && (permissions.recordPayment || permissions.viewPayments) && <InvoiceInstallmentPlan key={`${invoice.id}-${invoice.version}-${invoice.balance}`} invoiceId={invoice.id} currencyCode={invoice.currencyCode} balance={invoice.balance} canMake={permissions.recordPayment} canView={permissions.viewPayments} />}
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Payments</h2><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead><tbody>{invoice.payments.map((p) => <tr key={p.id}><td>{p.receivedOn}</td><td>{p.method}</td><td>{p.reference ?? '—'}</td><td>{money(p.amount, p.currencyCode)}</td><td><span className={`ap-badge ${p.status === 'Verified' ? 'ap-badge-on' : p.status === 'Rejected' || p.status === 'Reversed' ? 'ap-badge-off' : ''}`}>{p.status}</span>{p.statusReason && <div className="ap-foot">{p.statusReason}</div>}{p.receiptNumber && p.receiptId && <div><a href={`/backend/api/receipts/${p.receiptId}/pdf`} target="_blank" rel="noreferrer">Receipt {p.receiptNumber}</a></div>}</td><td><div className="ap-actions">{permissions.verifyPayment && p.status === 'Pending' && <><button className="ap-btn ap-btn-sm" disabled={busy} onClick={() => void paymentAction(p, 'verify')}>Verify</button><button className="ap-btn ap-btn-danger ap-btn-sm" disabled={busy} onClick={() => void paymentAction(p, 'reject')}>Reject</button></>}{permissions.verifyPayment && p.status === 'Verified' && <button className="ap-btn ap-btn-danger ap-btn-sm" disabled={busy} onClick={() => void paymentAction(p, 'reverse')}>Reverse</button>}</div></td></tr>)}</tbody></table>{invoice.payments.length === 0 && <p className="ap-foot">No payments recorded.</p>}</div></section>
    {invoice.creditNotes.length > 0 && <section className="ap-panel ap-stack"><h2 className="ap-h2">Credit notes</h2><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Number</th><th>Amount</th><th>Reason</th><th>Created</th><th>PDF</th></tr></thead><tbody>{invoice.creditNotes.map((c) => <tr key={c.id}><td>{c.number}</td><td>{money(c.amount, invoice.currencyCode)}</td><td>{c.reason}</td><td>{new Date(c.createdAtUtc).toLocaleDateString()}</td><td><a href={`/backend/api/invoices/${invoice.id}/credit-notes/${c.id}/pdf`} target="_blank" rel="noreferrer">Download</a></td></tr>)}</tbody></table></div></section>}
  </div>;
}
