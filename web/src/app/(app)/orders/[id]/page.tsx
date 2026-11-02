import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHead } from '@/components/app/PageHead';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { OrderActions } from '@/components/app/OrderActions';
import { OrderReferenceImages } from '@/components/app/OrderReferenceImages';
import { OrderInvoiceAction } from '@/components/app/OrderInvoiceAction';
import { QuotationPanel } from '@/components/app/QuotationPanel';
import { formatDateTime } from '@/lib/dates';
import { money } from '@/lib/format';
import type { Order } from '@/lib/order-types';
import type { InvoiceSummary, Paged } from '@/lib/finance-types';
import { formatDay, isLate, statusLabel, statusTone, todayIn } from '@/lib/orders';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Order · Avzar' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ scheduleReplanRequired?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  if (!GUID.test(id)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'orders.view')) return <NoAccess />;
  const res = await serverGet<Order>(`/api/orders/${id}`);
  if (!res.ok) { if (res.status === 404) notFound(); return <LoadError status={res.status} />; }
  const o = res.data;
  const invoiceHistory = can(me, 'invoices.view')
    ? await serverGet<Paged<InvoiceSummary>>(`/api/invoices?orderId=${encodeURIComponent(id)}&page=1&pageSize=50`)
    : null;
  const tone = statusTone(o.status);
  const late = isLate(o.status, o.promisedDate, todayIn(me.timeZoneId));
  const tz = me.timeZoneId;
  const when = (iso: string | null) => (iso ? formatDateTime(iso, tz) : null);
  const timeline = ([['Created', o.createdAtUtc], ['Quoted', o.quotedAtUtc], ['Confirmed', o.confirmedAtUtc], ['Ready', o.readyAtUtc], ['Delivered', o.deliveredAtUtc], ['Cancelled', o.cancelledAtUtc]] as const)
    .map(([label, iso]) => [label, when(iso)] as const).filter(([, v]) => v);
  const p = o.progress;

  return (
    <>
      <PageHead title={o.orderNumber} zone={tz} back={<Link href="/orders">← Orders</Link>} badges={<>
        <span className={`ap-badge${tone === 'on' ? ' ap-badge-on' : tone === 'off' ? ' ap-badge-off' : ''}`}>{statusLabel(o.status)}</span>
        {late && <span className="ap-badge ap-badge-off">Late</span>}
      </>} />

      {o.status === 'Cancelled' && o.cancellationReason && <p className="ap-alert" role="status">Cancelled: {o.cancellationReason}</p>}
      {query.scheduleReplanRequired === '1' && <section className="ap-panel ap-stack" role="status"><h2 className="ap-h2">Order amended — schedule review required</h2><p style={{ margin: 0 }}>Unstarted production task slots were cleared and need a replacement schedule. {can(me, 'tasks.manage') ? <Link href={`/tasks/schedule?replan=order-amendment&order=${encodeURIComponent(o.orderNumber)}`}>Review and publish the replacement schedule</Link> : 'A user with task-management permission must preview and publish the replacement schedule.'}</p></section>}

      <div className="ap-stack">
        <OrderActions order={o} canManage={can(me, 'orders.manage')} canConfirm={can(me, 'orders.confirm')} canEdit={can(me, 'orders.manage') && can(me, 'staff.view')} canManageTasks={can(me, 'tasks.manage')} />
        {o.quotedAtUtc && <QuotationPanel orderId={o.id} orderStatus={o.status} canManage={can(me, 'orders.manage')} timeZoneId={tz} />}
        <OrderInvoiceAction orderId={o.id} orderStatus={o.status} canManage={can(me, 'invoices.manage')} />
        {invoiceHistory?.ok && <section className="ap-panel ap-stack"><div className="ap-row"><h2 className="ap-h2">Invoice history</h2><span className="ap-foot">{invoiceHistory.data.totalCount} invoice(s)</span></div><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Status</th><th>Total</th><th>Paid</th><th>Balance</th><th>Due date</th></tr></thead><tbody>{invoiceHistory.data.items.map((invoice) => <tr key={invoice.id}><td><Link href={`/finance/invoices/${invoice.id}`}><strong>{invoice.number ?? 'Draft invoice'}</strong></Link><div className="ap-foot">{invoice.kind}</div></td><td>{invoice.status}{invoice.paymentStatus ? ` · ${invoice.paymentStatus}` : ''}</td><td>{money(invoice.total, invoice.currencyCode)}</td><td>{money(invoice.amountPaid, invoice.currencyCode)}</td><td>{money(invoice.balance, invoice.currencyCode)}</td><td>{invoice.dueDate ?? '—'}</td></tr>)}</tbody></table>{invoiceHistory.data.items.length === 0 && <p className="ap-foot">No invoices are linked to this order yet.</p>}</div></section>}
        {invoiceHistory && !invoiceHistory.ok && <p className="ap-alert" role="status">Invoice history could not be loaded (HTTP {invoiceHistory.status}).</p>}
        <section className="ap-panel" aria-labelledby="ord-h">
          <h2 id="ord-h" className="ap-h2">Order</h2>
          <dl className="ap-dl">
            <dt>Customer</dt>
            <dd>{can(me, 'customers.view') ? <Link href={`/customers/${o.customerId}`}>{o.customerName}</Link> : o.customerName}</dd>
            <dt>Promised</dt><dd>{formatDay(o.promisedDate)}</dd>
            <dt>Priority</dt><dd>{o.priority}</dd>
            <dt>Delivery</dt><dd>{o.deliveryMethod}{o.deliveryAddress ? ` · ${o.deliveryAddress}` : ''}</dd>
          </dl>
          {o.deliveryInstructions && <><h3 className="ap-h3">Delivery instructions</h3><p className="ap-pre">{o.deliveryInstructions}</p></>}
          {o.notes && <><h3 className="ap-h3">Notes</h3><p className="ap-pre">{o.notes}</p></>}
        </section>

        <section className="ap-panel" aria-labelledby="gar-h">
          <h2 id="gar-h" className="ap-h2">Garments</h2>
          <div className="ap-scroll">
            <table className="ap-table">
              <thead><tr><th>#</th><th>Item</th><th>Details</th><th>Qty</th><th>Unit</th><th>Line total</th></tr></thead>
              <tbody>
                {o.garments.map((g) => (
                  <tr key={g.id}>
                    <td>{g.lineNumber}</td>
                    <td><strong>{g.name}</strong>{g.designName && g.designName !== g.name ? <div className="ap-hint">Design: {g.designName}</div> : null}</td>
                    <td>
                      {[g.category, g.fabric, g.colour].filter(Boolean).join(' · ') || '—'}
                      {g.measurementRevision != null && <div className="ap-hint">Measurements r{g.measurementRevision}</div>}
                      {g.styleInstructions && <div className="ap-hint">{g.styleInstructions}</div>}
                      {g.alterationNotes && <div className="ap-hint">Alteration: {g.alterationNotes}</div>}
                    </td>
                    <td>{g.quantity}</td>
                    <td>{money(g.unitPrice, o.currencyCode)}</td>
                    <td>{money(g.lineTotal, o.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="ap-dl" style={{ marginTop: '1rem' }}>
            <dt>Subtotal</dt><dd>{money(o.subtotal, o.currencyCode)}</dd>
            <dt>Discount</dt><dd>{money(o.discount, o.currencyCode)}</dd>
            <dt>Total</dt><dd><strong>{money(o.total, o.currencyCode)}</strong></dd>
          </dl>
        </section>

        <OrderReferenceImages orderId={o.id} canManage={can(me, 'orders.manage')} orderCancelled={o.status === 'Cancelled'} />

        <section className="ap-panel" aria-labelledby="prog-h">
          <h2 id="prog-h" className="ap-h2">Production</h2>
          {p && p.totalTasks > 0 ? (
            <dl className="ap-dl">
              <dt>Progress</dt><dd>{p.percentComplete}% ({p.completed} of {p.totalTasks} tasks)</dd>
              <dt>In progress</dt><dd>{p.inProgress}</dd>
              <dt>Blocked</dt><dd>{p.blocked}</dd>
              <dt>Overdue</dt><dd>{p.overdue}</dd>
            </dl>
          ) : <p style={{ margin: 0 }}>No production tasks yet. They are created when the order is confirmed.</p>}
        </section>

        <section className="ap-panel" aria-labelledby="tl-h">
          <h2 id="tl-h" className="ap-h2">Timeline</h2>
          <dl className="ap-dl">{timeline.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        </section>
      </div>
    </>
  );
}
