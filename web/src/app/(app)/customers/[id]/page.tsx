import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CommunicationLog, type LogEntry } from '@/components/app/CommunicationLog';
import { CustomerPrivacyRequests } from '@/components/app/CustomerPrivacyRequests';
import { CustomerMessagingConsent } from '@/components/app/CustomerMessagingConsent';
import { CustomerMessagesSent } from '@/components/app/CustomerMessagesSent';
import { CustomerPortalLinkButton } from '@/components/app/CustomerPortalLinkButton';
import { PageHead } from '@/components/app/PageHead';
import { MergePanel } from '@/components/app/MergePanel';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { StatusControl } from '@/components/app/StatusControl';
import type { Communication, Customer } from '@/lib/customer-types';
import type { MeasurementSet } from '@/lib/measurement-types';
import { formatDate, formatDateTime } from '@/lib/dates';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';
import { isMeasurementStale } from '@/lib/measurement-view-model';

export const metadata = { title: 'Customer · Avzar' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GUID.test(id)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'customers.view')) return <NoAccess />;

  const [cust, comms] = await Promise.all([
    serverGet<Customer>(`/api/customers/${id}`),
    serverGet<Communication[]>(`/api/customers/${id}/communications`),
  ]);
  if (!cust.ok) { if (cust.status === 404) notFound(); return <LoadError status={cust.status} />; }
  if (!comms.ok) return <LoadError status={comms.status} />;

  const c = cust.data;
  const merged = c.status === 'Merged';
  // The API answers 409 for a merged customer's measurements, so do not ask. A failed load only affects this section.
  const sets = merged ? null : await serverGet<MeasurementSet[]>(`/api/customers/${id}/measurements`);
  // Recording needs an Active customer (customer_not_active otherwise), which is stricter than "not merged".
  const canRecord = can(me, 'measurements.record') && c.status === 'Active';
  const manage = can(me, 'customers.manage') && !merged;
  const entries: LogEntry[] = comms.data.map((x) => ({ id: x.id, channel: x.channel, direction: x.direction, subject: x.subject, body: x.body, when: formatDateTime(x.createdAtUtc, me.timeZoneId) }));

  return (
    <>
      <PageHead title={c.fullName} zone={me.timeZoneId} back={<Link href="/customers">← Customers</Link>} badges={<span className={c.status === 'Active' ? 'ap-badge ap-badge-on' : c.status === 'Inactive' ? 'ap-badge ap-badge-off' : 'ap-badge'}>{c.status}</span>}>
        {manage && <Link href={`/customers/${c.id}/edit`} className="ap-btn" style={{ textDecoration: 'none' }}>Edit</Link>}
      </PageHead>

      {merged && (
        <p className="ap-alert" role="status">
          This profile was merged into {c.mergedIntoCustomerId ? <Link href={`/customers/${c.mergedIntoCustomerId}`}>another customer</Link> : 'another customer'} and can no longer be edited.
        </p>
      )}

      <div className="ap-stack">
        <section className="ap-panel" aria-labelledby="details-h">
          <h2 id="details-h" className="ap-h2">Details</h2>
          <dl className="ap-dl">
            <dt>Email</dt><dd>{c.email || '—'}</dd>
            <dt>Phone</dt><dd>{c.phone || '—'}</dd>
            <dt>Address</dt><dd>{[c.addressLine, c.city].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Customer since</dt><dd>{formatDate(c.createdAtUtc, me.timeZoneId)}</dd>
          </dl>
          {manage && <div style={{ marginTop: '1rem' }}><CustomerPortalLinkButton customerId={c.id} /></div>}
          {c.garmentPreferences && <><h3 className="ap-h3">Garment preferences</h3><p className="ap-pre">{c.garmentPreferences}</p></>}
          {c.notes && <><h3 className="ap-h3">Notes</h3><p className="ap-pre">{c.notes}</p></>}
        </section>

        <section className="ap-panel" aria-labelledby="meas-h">
          <div className="ap-row">
            <h2 id="meas-h" className="ap-h2" style={{ margin: 0 }}>Measurements</h2>
            {canRecord && <Link href={`/customers/${c.id}/measurements/new`} className="ap-btn" style={{ textDecoration: 'none' }}>Add profile</Link>}
          </div>
          {merged ? <p className="ap-hint">Measurements are not available on a merged profile.</p>
            : !sets || !sets.ok ? <p className="ap-alert" role="status">Measurements could not be loaded right now. Reload the page to try again.</p>
            : sets.data.length === 0 ? <p className="ap-hint" style={{ margin: '.75rem 0 0' }}>No measurement profiles yet.</p>
            : (
              <div className="ap-scroll" style={{ marginTop: '.75rem' }}>
                <table className="ap-table">
                  <thead><tr><th scope="col">Profile</th><th scope="col">Template</th><th scope="col">Revision</th><th scope="col">Updated</th></tr></thead>
                  <tbody>
                    {sets.data.map((s) => (
                      <tr key={s.id}>
                        <td><Link href={`/customers/${c.id}/measurements/${s.id}`}><strong>{s.label}</strong></Link>{isMeasurementStale(s.updatedAtUtc) && <p className="ap-alert" role="status">Measurements are older than 90 days. Recheck them before cutting a new garment.</p>}</td>
                        <td>{s.templateName}</td>
                        <td>{s.currentRevision}</td>
                        <td>{formatDateTime(s.updatedAtUtc, me.timeZoneId)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>

        <section className="ap-panel" aria-labelledby="comm-h">
          <h2 id="comm-h" className="ap-h2">Communication log</h2>
          <CommunicationLog customerId={c.id} entries={entries} canManage={manage} />
        </section>

        <CustomerMessagingConsent customerId={c.id} canManage={manage} />
        <CustomerMessagesSent customerId={c.id} />

        {manage && <CustomerPrivacyRequests customerId={c.id} />}

        {manage && (
          <section className="ap-panel" aria-labelledby="status-h">
            <h2 id="status-h" className="ap-h2">Status</h2>
            <StatusControl customerId={c.id} status={c.status as 'Active' | 'Inactive'} />
          </section>
        )}

        {manage && can(me, 'customers.merge') && can(me, 'locations.all') && (
          <section className="ap-panel" aria-labelledby="merge-h">
            <h2 id="merge-h" className="ap-h2">Merge duplicate</h2>
            <MergePanel sourceId={c.id} sourceName={c.fullName} />
          </section>
        )}
      </div>
    </>
  );
}
