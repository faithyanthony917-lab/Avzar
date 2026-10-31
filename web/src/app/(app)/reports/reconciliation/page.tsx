import { PageHead } from '@/components/app/PageHead';
import Link from 'next/link';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { ReconciliationExport } from '@/components/app/ReconciliationExport';
import { ReportTabs } from '@/components/app/ReportTabs';
import { money } from '@/lib/format';
import { attentionSummary, cutNote, methodLabel, reasonLabel, type ReconciliationReport } from '@/lib/reconciliation';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Payment reconciliation · Avzar' };
export const dynamic = 'force-dynamic';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const day = (value: string | null) => (value ? value.slice(0, 10) : '—');

function InvoiceLink({ id, number }: { id: string; number: string | null }) {
  return <Link href={`/finance/invoices/${id}`}>{number ?? 'Invoice'}</Link>;
}

function Cut({ list }: { list: { count: number; truncated: boolean; items: unknown[] } }) {
  const note = cutNote(list);
  return note ? <p className="ap-foot" role="status">{note}</p> : null;
}

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = (await getSession())!;
  if (!can(me, 'reports.view') || !can(me, 'payments.view')) return <NoAccess />;
  const q = await searchParams;
  const to = first(q.to) || new Date().toISOString().slice(0, 10);
  const from = first(q.from) || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const res = await serverGet<ReconciliationReport>(`/api/reports/reconciliation?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (!res.ok) return <LoadError status={res.status} />;
  const r = res.data;
  const fmt = (amount: number, currency = r.currencyCode) => money(amount, currency) ?? '—';
  const n = r.needsAttention;
  return (
    <div className="ap-stack">
      <PageHead title="Reports & analytics" intro="Payment reconciliation compares what customers paid with what your invoices recorded. It only reads: nothing here changes a payment, and Avzar does not check Paystack&apos;s own settlement list." zone={me.timeZoneId} />
      <ReportTabs showReconciliation />
      <form className="ap-panel ap-filter" method="get">
        <label htmlFor="rec-from">From</label>
        <input id="rec-from" className="ap-input" type="date" name="from" required defaultValue={r.from} />
        <label htmlFor="rec-to">To</label>
        <input id="rec-to" className="ap-input" type="date" name="to" required defaultValue={r.to} />
        <button className="ap-btn">Run report</button>
        <ReconciliationExport report={r} />
      </form>
      <p role="status"><strong>{attentionSummary(r.attentionCount)}</strong> <span className="ap-foot">Up to 92 days. Open items (money to review, payments not verified) are shown whatever their date.</span></p>

      <section className="ap-panel ap-stack" aria-labelledby="rec-collected">
        <h2 className="ap-h2" id="rec-collected">Collected</h2>
        <p className="ap-foot">Verified payments from {r.from} to {r.to}. Online means paid through a payment link.</p>
        {r.collected.count === 0 ? <p className="ap-foot">No verified payments in this period.</p> : (
          <>
            <div className="ap-grid2">
              <div><p className="ap-foot">Total</p><strong>{fmt(r.collected.amount)}</strong> <span className="ap-foot">({r.collected.count})</span></div>
              <div><p className="ap-foot">Online</p><strong>{fmt(r.collected.online.amount)}</strong> <span className="ap-foot">({r.collected.online.count})</span></div>
              <div><p className="ap-foot">Recorded by staff</p><strong>{fmt(r.collected.staffRecorded.amount)}</strong> <span className="ap-foot">({r.collected.staffRecorded.count})</span></div>
            </div>
            <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Method</th><th>Payments</th><th>Amount</th></tr></thead><tbody>
              {r.collected.byMethod.map((l) => <tr key={`${l.method}-${l.online}`}><td>{methodLabel(l.method)}{l.online ? ' (online)' : ''}</td><td>{l.count}</td><td>{fmt(l.amount)}</td></tr>)}
            </tbody></table></div>
          </>
        )}
      </section>

      <section className="ap-panel ap-stack" aria-labelledby="rec-review">
        <h2 className="ap-h2" id="rec-review">Money to review ({n.needsReviewPayments.count})</h2>
        <p className="ap-foot">A customer paid online, but the invoice could not take the money. Refund it in Paystack or reassign it. Avzar does not move the money for you.</p>
        {n.needsReviewPayments.items.length === 0 ? <p className="ap-foot">Nothing to review.</p> : (
          <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Amount</th><th>Reference</th><th>Why</th><th>Date</th></tr></thead><tbody>
            {n.needsReviewPayments.items.map((i) => <tr key={i.id}><td><InvoiceLink id={i.invoiceId} number={i.invoiceNumber} /></td><td>{fmt(i.amount, i.currencyCode)}</td><td>{i.reference}</td><td>{reasonLabel(i.reason)}</td><td>{day(i.updatedAtUtc)}</td></tr>)}
          </tbody></table></div>
        )}
        <Cut list={n.needsReviewPayments} />
      </section>

      <section className="ap-panel ap-stack" aria-labelledby="rec-mismatch">
        <h2 className="ap-h2" id="rec-mismatch">Online payments that no longer match ({n.onlineMismatches.count})</h2>
        <p className="ap-foot">Paid online, but the payment was later reversed or changed in Avzar. Reversing a payment in Avzar does not refund the customer.</p>
        {n.onlineMismatches.items.length === 0 ? <p className="ap-foot">None in this period.</p> : (
          <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Paid online</th><th>Reference</th><th>What changed</th></tr></thead><tbody>
            {n.onlineMismatches.items.map((i) => <tr key={i.id}><td><InvoiceLink id={i.invoiceId} number={i.invoiceNumber} /></td><td>{fmt(i.amount, i.currencyCode)}</td><td>{i.reference}</td><td>{i.note}</td></tr>)}
          </tbody></table></div>
        )}
        <Cut list={n.onlineMismatches} />
      </section>

      <section className="ap-panel ap-stack" aria-labelledby="rec-stale">
        <h2 className="ap-h2" id="rec-stale">Payment links that expired unpaid ({n.staleLinks.count})</h2>
        <p className="ap-foot">If Paystack&apos;s message never reached Avzar, the customer may still have paid. Check the reference in Paystack before sending a new link.</p>
        {n.staleLinks.items.length === 0 ? <p className="ap-foot">None in this period.</p> : (
          <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Amount</th><th>Reference</th><th>Started</th><th>Expired</th></tr></thead><tbody>
            {n.staleLinks.items.map((i) => <tr key={i.id}><td><InvoiceLink id={i.invoiceId} number={i.invoiceNumber} /></td><td>{fmt(i.amount, i.currencyCode)}</td><td>{i.reference}</td><td>{day(i.createdAtUtc)}</td><td>{day(i.expiredAtUtc)}</td></tr>)}
          </tbody></table></div>
        )}
        <Cut list={n.staleLinks} />
      </section>

      <section className="ap-panel ap-stack" aria-labelledby="rec-pending">
        <h2 className="ap-h2" id="rec-pending">Recorded and not verified ({n.pendingVerification.count})</h2>
        <p className="ap-foot">Payments staff recorded that nobody has verified for {n.pendingVerification.thresholdDays} days or more. They do not count toward an invoice until verified.</p>
        {n.pendingVerification.items.length === 0 ? <p className="ap-foot">Nothing waiting.</p> : (
          <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Amount</th><th>Method</th><th>Reference</th><th>Received</th></tr></thead><tbody>
            {n.pendingVerification.items.map((i) => <tr key={i.id}><td><InvoiceLink id={i.invoiceId} number={i.invoiceNumber} /></td><td>{fmt(i.amount, i.currencyCode)}</td><td>{methodLabel(i.method)}</td><td>{i.reference ?? '—'}</td><td>{i.receivedOn ?? '—'}</td></tr>)}
          </tbody></table></div>
        )}
        <Cut list={n.pendingVerification} />
      </section>

      <section className="ap-panel ap-stack" aria-labelledby="rec-voided">
        <h2 className="ap-h2" id="rec-voided">Payments on voided invoices ({n.paymentsOnVoidedInvoices.count})</h2>
        <p className="ap-foot">Verified payments whose invoice was voided afterwards. Refund or reassign the money.</p>
        {n.paymentsOnVoidedInvoices.items.length === 0 ? <p className="ap-foot">None in this period.</p> : (
          <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Amount</th><th>Method</th><th>Reference</th><th>Verified</th></tr></thead><tbody>
            {n.paymentsOnVoidedInvoices.items.map((i) => <tr key={i.id}><td><InvoiceLink id={i.invoiceId} number={i.invoiceNumber} /></td><td>{fmt(i.amount, i.currencyCode)}</td><td>{methodLabel(i.method)}{i.online ? ' (online)' : ''}</td><td>{i.reference ?? '—'}</td><td>{day(i.verifiedAtUtc)}</td></tr>)}
          </tbody></table></div>
        )}
        <Cut list={n.paymentsOnVoidedInvoices} />
      </section>

      <section className="ap-panel ap-stack" aria-labelledby="rec-open">
        <h2 className="ap-h2" id="rec-open">Invoices still owed (as of {r.asOf})</h2>
        <div className="ap-grid2">
          <div><p className="ap-foot">Issued with a balance</p><strong>{r.invoices.openCount}</strong> <span className="ap-foot">{fmt(r.invoices.openBalance)}</span></div>
          <div><p className="ap-foot">Past their due date</p><strong>{r.invoices.overdueCount}</strong> <span className="ap-foot">{fmt(r.invoices.overdueBalance)}</span></div>
        </div>
        <h3 className="ap-h2">Overdue installments ({r.invoices.installmentsOverdue.installments})</h3>
        {r.invoices.installmentsOverdue.items.length === 0 ? <p className="ap-foot">No installment is overdue.</p> : (
          <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Overdue</th><th>Amount</th><th>Oldest due</th></tr></thead><tbody>
            {r.invoices.installmentsOverdue.items.map((i) => <tr key={i.invoiceId}><td><InvoiceLink id={i.invoiceId} number={i.invoiceNumber} />{!i.matchesInvoice && <span className="ap-badge ap-badge-off">Plan does not match invoice</span>}</td><td>{i.overdueCount}</td><td>{fmt(i.overdueAmount)}</td><td>{i.oldestDueDate}</td></tr>)}
          </tbody></table></div>
        )}
        {r.invoices.installmentsOverdue.truncated && <p className="ap-foot" role="status">More plans exist than are shown.</p>}
      </section>
    </div>
  );
}
