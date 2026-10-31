'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { balanceByCurrency, portalTokenFromHash } from '@/lib/customer-portal';
import { redirectTo } from '@/lib/navigate';
import { installmentBadgeClass, installmentLabel, type InstallmentPlan } from '@/lib/installment-plan';
import { CustomerPortalQuotations } from './CustomerPortalQuotations';
import { CustomerPrivacyRequestForm } from './CustomerPrivacyRequestForm';

type Portal = {
  customerName: string; businessName: string; currencyCode: string; onlinePaymentsEnabled?: boolean;
  orders: { id: string; orderNumber: string; status: string; promisedDate: string; total: number; currencyCode: string; progress: { stage: string; status: string; completedAtUtc: string | null }[] }[];
  invoices: { id: string; number: string | null; status: string; issueDate: string | null; dueDate: string | null; total: number; currencyCode: string; verifiedPaid: number; balance: number; payments: { amount: number; currencyCode: string; method: string; receivedOn: string; reference: string | null }[]; installmentPlan?: InstallmentPlan | null }[];
};

const money = (amount: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);

export function CustomerPortalClient() {
  const [data, setData] = useState<Portal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [portalToken, setPortalToken] = useState<string | null>(null);
  const [returnedFromPayment, setReturnedFromPayment] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payError, setPayError] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    const token = portalTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!token && new URLSearchParams(window.location.search).get('payment') === 'complete') {
      setReturnedFromPayment(true);
      setLoading(false);
      return;
    }
    if (!token) {
      setError('This portal link is missing or has already been opened. Request a new link from the business.');
      setLoading(false);
      return;
    }
    setPortalToken(token);
    void api<Portal>('/api/customer-portal/access', { method: 'POST', json: { token } })
      .then((value) => { if (active) setData(value); })
      .catch((err) => { if (active) setError(messageFor(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  if (loading) return <main className="ap-main ap-portal-main"><section className="ap-panel">Opening your secure customer portal…</section></main>;
  if (returnedFromPayment && !data) return <main className="ap-main ap-portal-main"><section className="ap-panel"><h1>Thank you</h1><p>Your payment is being confirmed. It can take a minute to show on your invoice.</p><p>To see it, open the portal link you were sent again.</p></section></main>;
  if (error || !data) return <main className="ap-main ap-portal-main"><section className="ap-panel"><h1>Customer portal unavailable</h1><p>{error || 'This link may have expired.'}</p><p>Contact the business to request a fresh link.</p></section></main>;

  const due = balanceByCurrency(data.invoices);
  async function payOnline(invoiceId: string, amount?: number) {
    if (!portalToken) return;
    setPayingId(invoiceId); setPayError(null);
    try {
      const result = await api<{ attempt: { authorizationUrl: string | null } }>('/api/customer-portal/invoices/pay', { method: 'POST', json: { token: portalToken, invoiceId, ...(amount === undefined ? {} : { amount }) } });
      if (!result.attempt.authorizationUrl) throw new Error('missing_url');
      redirectTo(result.attempt.authorizationUrl);
    } catch (err) {
      setPayError({ id: invoiceId, message: err instanceof Error && err.message === 'missing_url' ? 'The payment page could not be opened. Try again.' : messageFor(err) });
      setPayingId(null);
    }
  }
  return <main className="ap-main ap-portal-main"><div className="ap-stack">
    <header><p className="ap-eyebrow">{data.businessName}</p><h1 className="ap-portal-title">Hello, {data.customerName}</h1><p className="ap-foot">Your orders, production progress, invoices and verified payments.</p></header>
    <section className="ap-banner" aria-label="Balance due">
      <div className="ap-banner-label">Balance due</div>
      <strong className="ap-banner-value">{due.length === 0 ? money(0, data.currencyCode) : due.map((d) => money(d.amount, d.currency)).join(' + ')}</strong>
      <div className="ap-banner-rule" aria-hidden="true" />
      <div className="ap-banner-foot"><span>Verified payments are already taken off.</span><span className="ap-banner-chip">{data.orders.length} order{data.orders.length === 1 ? '' : 's'}</span></div>
    </section>
    {portalToken && <><CustomerPortalQuotations token={portalToken} /><CustomerPrivacyRequestForm token={portalToken} /></>}
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Your orders</h2>
      {data.orders.length === 0 ? <p>No orders are available.</p> : data.orders.map((order) => <article key={order.id} className="ap-portal-order">
        <div className="ap-row"><strong>{order.orderNumber}</strong><span className="ap-badge">{order.status}</span></div>
        <p className="ap-foot">Promised date: {order.promisedDate} · {money(order.total, order.currencyCode)}</p>
        <ol className="ap-track">{order.progress.map((progress, index) => <li className={progress.completedAtUtc ? 'is-done' : undefined} key={`${progress.stage}-${index}`}>{progress.stage}: {progress.status}{progress.completedAtUtc ? ` · completed ${new Date(progress.completedAtUtc).toLocaleDateString()}` : ''}</li>)}</ol>
      </article>)}
    </section>
    <section className="ap-panel ap-stack"><h2 className="ap-h2">Invoices and payments</h2>
      {data.invoices.length === 0 ? <p>No invoices are available.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Status</th><th>Issued</th><th>Total</th><th>Paid</th><th>Balance / receipts</th></tr></thead><tbody>{data.invoices.map((invoice) => <tr key={invoice.id}>
        <td>{invoice.number ?? 'Draft'}</td><td>{invoice.status}</td><td>{invoice.issueDate ?? '—'}</td><td>{money(invoice.total, invoice.currencyCode)}</td><td>{money(invoice.verifiedPaid, invoice.currencyCode)}</td>
        <td>{money(invoice.balance, invoice.currencyCode)}{data.onlinePaymentsEnabled && portalToken && invoice.status === 'Issued' && invoice.balance > 0 && <div><button type="button" className="ap-btn ap-btn-sm" disabled={payingId !== null} onClick={() => void payOnline(invoice.id)}>{payingId === invoice.id ? 'Opening payment page…' : 'Pay online'}</button>{payError?.id === invoice.id && <p className="ap-alert" role="alert">{payError.message}</p>}</div>}{invoice.status === 'Issued' && invoice.installmentPlan && invoice.installmentPlan.state === 'Active' && <details open><summary>Payment plan</summary>
          <ol>{invoice.installmentPlan.installments.map((row) => <li key={row.sequence}>{row.dueDate} · {money(row.amount, invoice.currencyCode)} · <span className={installmentBadgeClass(row)}>{installmentLabel(row)}</span>{row.status === 'PartPaid' && ` · ${money(row.outstanding, invoice.currencyCode)} left`}</li>)}</ol>
          {data.onlinePaymentsEnabled && portalToken && invoice.installmentPlan.next && invoice.installmentPlan.next.payAmount > 0 && <button type="button" className="ap-btn ap-btn-sm" disabled={payingId !== null} onClick={() => void payOnline(invoice.id, invoice.installmentPlan!.next!.payAmount)}>{payingId === invoice.id ? 'Opening payment page…' : `Pay next installment (${money(invoice.installmentPlan.next.payAmount, invoice.currencyCode)})`}</button>}</details>}{invoice.payments.length > 0 && <details><summary>Payment history</summary><ul>{invoice.payments.map((payment, index) => <li key={`${payment.receivedOn}-${index}`}>{payment.receivedOn} · {payment.method} · {money(payment.amount, payment.currencyCode)}{payment.reference ? ` · ${payment.reference}` : ''}</li>)}</ul></details>}</td>
      </tr>)}</tbody></table></div>}
    </section>
    <p className="ap-foot">For changes or payment questions, contact {data.businessName} directly. This secure link expires and can be revoked by the business.</p>
  </div></main>;
}
