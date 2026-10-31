import { PageHead } from '@/components/app/PageHead';
import Link from 'next/link';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';
import type { ExpenseSummary, InvoiceSummary, Paged, Payment } from '@/lib/finance-types';
import { money } from '@/lib/finance-types';
import { ExpenseManager } from '@/components/app/ExpenseManager';

export const metadata = { title: 'Finance · Avzar' };
export const dynamic = 'force-dynamic';

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = (await getSession())!;
  const permissions = { invoices: can(me, 'invoices.view'), payments: can(me, 'payments.view'), expenses: can(me, 'expenses.view') };
  const canManageInvoices = can(me, 'invoices.manage');
  if (!permissions.invoices && !permissions.payments && !permissions.expenses) return <NoAccess />;
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v;
  const search = (first(params.search) ?? '').trim().slice(0, 100);
  const status = (first(params.status) ?? '').slice(0, 30);
  const outstanding = first(params.outstanding) === 'true';
  const overdue = first(params.overdue) === 'true';
  const pageRaw = first(params.page) ?? '1';
  const page = /^\d{1,5}$/.test(pageRaw) && Number(pageRaw) >= 1 && Number(pageRaw) <= 10000 ? Number(pageRaw) : 1;
  const query = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (search) query.set('search', search); if (status) query.set('status', status); if (outstanding) query.set('outstanding', 'true'); if (overdue) query.set('overdue', 'true');
  const [invoices, payments, expenses] = await Promise.all([
    permissions.invoices ? serverGet<Paged<InvoiceSummary>>(`/api/invoices?${query.toString()}`) : Promise.resolve(null),
    permissions.payments ? serverGet<Paged<Payment>>('/api/payments?page=1&pageSize=10&status=Pending') : Promise.resolve(null),
    permissions.expenses ? serverGet<ExpenseSummary>('/api/expenses/summary') : Promise.resolve(null),
  ]);
  const failure = [invoices, payments, expenses].find((r) => r && !r.ok);
  if (failure && failure && !failure.ok) return <LoadError status={failure.status} />;
  const invoiceData = invoices?.ok ? invoices.data : null;
  const paymentData = payments?.ok ? payments.data : null;
  const expenseData = expenses?.ok ? expenses.data : null;
  return <div className="ap-stack">
    <PageHead title="Finance" intro="Invoices, payment verification and recorded expenses. A payment claim does not count as money received until it is verified." zone={me.timeZoneId} />
    {permissions.invoices && invoiceData && <section className="ap-panel ap-stack"><div className="ap-row"><h2 className="ap-h2">Invoices</h2><div className="ap-actions"><span className="ap-foot">{invoiceData.totalCount} total</span>{canManageInvoices && <Link className="ap-btn ap-btn-sm" href="/finance/invoices/new" style={{ textDecoration: 'none' }}>New invoice</Link>}</div></div><form method="get" action="/finance" className="ap-filter" role="search"><label className="ap-sr" htmlFor="finance-search">Search invoices</label><input id="finance-search" name="search" className="ap-input" placeholder="Invoice number or customer" maxLength={100} defaultValue={search} /><label className="ap-sr" htmlFor="finance-status">Invoice status</label><select id="finance-status" name="status" className="ap-input" defaultValue={status}><option value="">All statuses</option><option value="Draft">Draft</option><option value="Issued">Issued</option><option value="Void">Void</option></select><label className="ap-check"><input type="checkbox" name="outstanding" value="true" defaultChecked={outstanding} /> Outstanding</label><label className="ap-check"><input type="checkbox" name="overdue" value="true" defaultChecked={overdue} /> Overdue</label><button className="ap-btn">Apply</button></form><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Total</th><th>Paid</th><th>Balance</th><th>Due</th></tr></thead><tbody>{invoiceData.items.map((i) => <tr key={i.id} className={i.isOverdue ? 'ap-task-attention' : undefined}><td><Link href={`/finance/invoices/${i.id}`}><strong>{i.number ?? 'Draft invoice'}</strong></Link><div className="ap-foot">{i.kind}{i.orderId ? ' · Order invoice' : ''}</div></td><td>{i.customerName}</td><td><span className={`ap-badge ${i.status === 'Issued' && i.paymentStatus === 'Paid' ? 'ap-badge-on' : i.isOverdue || i.status === 'Void' ? 'ap-badge-off' : ''}`}>{i.status}{i.paymentStatus ? ` · ${i.paymentStatus}` : ''}</span></td><td>{money(i.total, i.currencyCode)}</td><td>{money(i.amountPaid, i.currencyCode)}</td><td>{money(i.balance, i.currencyCode)}</td><td>{i.dueDate ?? '—'}{i.isOverdue && <div className="ap-err">Overdue</div>}</td></tr>)}</tbody></table>{invoiceData.items.length === 0 && <p className="ap-foot">No invoices match these filters.</p>}</div><div className="ap-row"><span className="ap-foot">Page {invoiceData.page} · {invoiceData.totalCount} invoices</span><div className="ap-actions">{invoiceData.page > 1 && <Link className="ap-btn ap-btn-quiet ap-btn-sm" href={`/finance?${new URLSearchParams({ ...(search ? { search } : {}), ...(status ? { status } : {}), ...(outstanding ? { outstanding: 'true' } : {}), ...(overdue ? { overdue: 'true' } : {}), page: String(invoiceData.page - 1) })}`}>Previous</Link>}{invoiceData.page * invoiceData.pageSize < invoiceData.totalCount && <Link className="ap-btn ap-btn-quiet ap-btn-sm" href={`/finance?${new URLSearchParams({ ...(search ? { search } : {}), ...(status ? { status } : {}), ...(outstanding ? { outstanding: 'true' } : {}), ...(overdue ? { overdue: 'true' } : {}), page: String(invoiceData.page + 1) })}`}>Next</Link>}</div></div></section>}
    {permissions.payments && paymentData && <section className="ap-panel ap-stack"><div className="ap-row"><h2 className="ap-h2">Pending payment claims</h2><span className="ap-foot">Latest {paymentData.items.length}</span></div><p className="ap-foot" style={{ margin: 0 }}>Only users with `payments.verify` can confirm or reject claims on the invoice detail page.</p><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Invoice</th><th>Received</th><th>Method</th><th>Amount</th><th>Reference</th></tr></thead><tbody>{paymentData.items.map((p) => <tr key={p.id}><td><Link href={`/finance/invoices/${p.invoiceId}`}>{p.invoiceNumber ?? 'Open invoice'}</Link></td><td>{p.receivedOn}</td><td>{p.method}</td><td>{money(p.amount, p.currencyCode)}</td><td>{p.reference ?? '—'}</td></tr>)}</tbody></table>{paymentData.items.length === 0 && <p className="ap-foot">No pending payment claims.</p>}</div></section>}
    {permissions.expenses && expenseData && <><section className="ap-panel ap-stack"><div className="ap-row"><h2 className="ap-h2">Expense summary</h2><div className="ap-actions"><a className="ap-btn ap-btn-quiet ap-btn-sm" href="/backend/api/expenses/export">Export CSV</a><strong>{money(expenseData.total, expenseData.currencyCode)}</strong></div></div><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Category</th><th>Entries</th><th>Total</th></tr></thead><tbody>{expenseData.byCategory.map((e) => <tr key={e.categoryId}><td>{e.categoryName}</td><td>{e.count}</td><td>{money(e.total, expenseData.currencyCode)}</td></tr>)}</tbody></table>{expenseData.byCategory.length === 0 && <p className="ap-foot">No expenses recorded in the selected scope.</p>}</div></section><ExpenseManager canManage={can(me, 'expenses.manage')} /></>}
  </div>;
}
