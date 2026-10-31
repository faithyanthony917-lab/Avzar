'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { toast } from '@/lib/toast';
import { ApiError, messageFor } from '@/lib/problem';
import { attemptStatusLabel, onlinePaymentMessage, type PaymentAttempt } from '@/lib/invoice-online-payment';
import { money } from '@/lib/finance-types';

type Props = { invoiceId: string; currencyCode: string; balance: number; canStart: boolean; canView: boolean };

/** Invoice page section: make a card-payment link to send to the customer, and see every attempt. */
export function InvoiceOnlinePayment({ invoiceId, currencyCode, balance, canStart, canView }: Props) {
  const [attempts, setAttempts] = useState<PaymentAttempt[] | null>(null);
  const [listError, setListError] = useState('');
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notSetUp, setNotSetUp] = useState(false);
  const [link, setLink] = useState('');

  const load = useCallback(async () => {
    if (!canView) return;
    setListError('');
    try { setAttempts((await api<{ items: PaymentAttempt[] }>(`/api/invoices/${invoiceId}/online-payments`)).items); }
    catch (err) { setListError(messageFor(err)); }
  }, [canView, invoiceId]);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const value = amount.trim() === '' ? undefined : Number(amount);
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > balance)) { setError(`Enter an amount above zero and not more than the balance (${money(balance, currencyCode)}).`); return; }
    setBusy(true); setError(''); setNotSetUp(false);
    try {
      const result = await api<{ attempt: PaymentAttempt; created: boolean }>(`/api/invoices/${invoiceId}/online-payment`, {
        method: 'POST', idempotencyKey: key, ...(value === undefined ? {} : { json: { amount: value } }),
      });
      setLink(result.attempt.authorizationUrl ?? '');
      setKey(crypto.randomUUID());
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'online_payments_not_set_up') setNotSetUp(true);
      setError(onlinePaymentMessage(err));
    } finally { setBusy(false); }
  }

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); toast.success('Link copied.'); } catch { toast.error('Could not copy. Select the link and copy it by hand.'); }
  }

  if (!canStart && !canView) return null;
  return <section className="ap-panel ap-stack" aria-labelledby="online-payment">
    <h2 id="online-payment" className="ap-h2">Online payment</h2>
    {canStart && <form className="ap-stack" noValidate onSubmit={(e) => void create(e)}>
      <p className="ap-foot" style={{ margin: 0 }}>Make a card-payment link and send it to the customer. The payment is recorded only after Paystack confirms it.</p>
      <div className="ap-field"><label htmlFor="online-amount">Amount ({currencyCode}), optional</label>
        <input id="online-amount" type="number" min="0.01" step="0.01" max={balance} className="ap-input" value={amount} disabled={busy}
          onChange={(e) => { setAmount(e.target.value); setKey(crypto.randomUUID()); }} />
        <p className="ap-foot" style={{ margin: 0 }}>Leave empty to ask for the whole balance ({money(balance, currencyCode)}). A part payment needs a plan that allows it.</p></div>
      <div className="ap-actions"><button className="ap-btn" disabled={busy}>{busy ? 'Making link…' : 'Create payment link'}</button></div>
      {error && <p className="ap-alert" role="alert">{error}{notSetUp && <> <Link href="/settings">Open Settings</Link></>}</p>}
      {link && <div className="ap-stack"><label htmlFor="online-link">Payment link</label>
        <input id="online-link" className="ap-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <div className="ap-actions"><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void copy(link)}>Copy link</button></div></div>}
    </form>}
    {canView && (listError ? <p className="ap-alert" role="alert">{listError}</p>
      : attempts === null ? <p className="ap-foot" role="status">Loading online payments…</p>
      : attempts.length === 0 ? <p className="ap-foot">No online payments started for this invoice.</p>
      : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Started</th><th>Amount</th><th>Started by</th><th>Status</th><th>Link</th></tr></thead><tbody>
        {attempts.map((a) => <tr key={a.id}><td>{new Date(a.createdAtUtc).toLocaleString()}</td><td>{money(a.amount, a.currencyCode)}</td><td>{a.source === 'Portal' ? 'Customer' : 'Staff'}</td>
          <td><span className={`ap-badge ${a.status === 'Paid' ? 'ap-badge-on' : a.status === 'Failed' || a.status === 'NeedsReview' ? 'ap-badge-off' : ''}`}>{attemptStatusLabel(a.status)}</span>
            {a.status === 'NeedsReview' && <div className="ap-foot">The customer paid but the invoice could not take it. Refund or reassign the money.</div>}</td>
          <td>{a.authorizationUrl ? <button type="button" className="ap-btn ap-btn-sm ap-btn-quiet" onClick={() => void copy(a.authorizationUrl!)}>Copy link</button> : '—'}</td></tr>)}
      </tbody></table></div>)}
  </section>;
}
