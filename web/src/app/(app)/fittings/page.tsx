import { PageHead } from '@/components/app/PageHead';
import { ExportCsvButton } from '@/components/app/ExportCsvButton';
import Link from 'next/link';
import { FittingForm } from '@/components/app/FittingForm';
import { AppointmentActions } from '@/components/app/FittingStatusControl';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { CustomerSummary, Paged } from '@/lib/customer-types';
import { totalPages } from '@/lib/customers';
import { formatDateTime } from '@/lib/dates';
import { APPOINTMENT_TYPES, FITTINGS_PAGE_SIZE, fittingStatusLabel, fittingStatusTone, fittingsApiQuery, fittingsHref, needsOutcome, parseFittingsQuery, type Appointment } from '@/lib/fittings-view-model';
import { getSession, serverGet } from '@/lib/session';
import type { Location, StaffMember } from '@/lib/staff-types';
import { can } from '@/lib/team';

export const metadata = { title: 'Appointments · Avzar' };
export const dynamic = 'force-dynamic';

export default async function FittingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = (await getSession())!;
  if (!can(me, 'orders.view')) return <NoAccess />;
  const q = parseFittingsQuery(await searchParams);
  const canManage = can(me, 'fittings.manage');
  const canCustomers = can(me, 'customers.view');
  const canLocations = can(me, 'staff.view');

  // Names and the schedule form need customers.view and staff.view (the locations and staff lists); the fitting list itself needs only orders.view.
  const [appointments, customers, locations, staff] = await Promise.all([
    serverGet<Paged<Appointment>>(`/api/appointments?${fittingsApiQuery(q, me.timeZoneId)}`),
    canCustomers ? serverGet<Paged<CustomerSummary>>('/api/customers?page=1&pageSize=100&sort=name') : null,
    canLocations ? serverGet<Location[]>('/api/locations') : null,
    canLocations ? serverGet<StaffMember[]>('/api/staff') : null,
  ]);
  if (!appointments.ok) return <LoadError status={appointments.status} />;

  const customerList = customers?.ok ? customers.data.items : null;
  const customerNames = new Map((customerList ?? []).map((c) => [c.id, c.fullName]));
  const locationList = locations?.ok ? locations.data : null;
  const locationNames = new Map((locationList ?? []).map((l) => [l.id, l.name]));

  const allowedIds = me.isOwner || can(me, 'locations.all') ? null : new Set(staff?.ok ? staff.data.find((m) => m.userId === me.userId)?.locationIds ?? [] : []);
  const formCustomers = (customerList ?? []).filter((c) => c.status === 'Active').map((c) => ({ id: c.id, label: c.fullName }));
  const formStaff = (staff?.ok ? staff.data : []).filter((member) => member.status === 'Active')
    .map((member) => ({ id: member.membershipId, label: member.displayName, isOwner: member.isOwner, locationIds: member.locationIds }));
  const currentMembershipId = staff?.ok ? staff.data.find((member) => member.userId === me.userId)?.membershipId ?? null : null;
  const formLocations = (locationList ?? []).filter((l) => l.isActive && (allowedIds === null || allowedIds.has(l.id))).map((l) => ({ id: l.id, label: l.name }));
  const formReady = canManage && !!customerList && !!locationList && !!staff?.ok;

  const { items, totalCount } = appointments.data;
  const pages = totalPages(totalCount, appointments.data.pageSize || FITTINGS_PAGE_SIZE);
  const now = new Date();

  return (
    <div className="ap-stack">
      <PageHead title="Appointments" intro={`Schedule and manage customer appointments. Times are shown in ${me.timeZoneId}.`} zone={me.timeZoneId}>
        <ExportCsvButton path="/api/appointments/export" query={fittingsApiQuery(q, me.timeZoneId)} fileName="appointments.csv" />
      </PageHead>

      {formReady && formCustomers.length > 0 && formLocations.length > 0 && formStaff.length > 0 && <FittingForm customers={formCustomers} locations={formLocations} staff={formStaff} currentMembershipId={currentMembershipId} canAssignAllLocations={me.isOwner || can(me, 'locations.all')} timeZone={me.timeZoneId} />}
      {formReady && (formCustomers.length === 0 || formLocations.length === 0) && (
        <p className="ap-hint">{formCustomers.length === 0 ? 'Add an active customer before scheduling a fitting.' : 'You are not assigned to an active location, so you cannot schedule fittings. Ask the business owner to assign one.'}</p>
      )}
      {formReady && formCustomers.length > 0 && formLocations.length > 0 && formStaff.length === 0 && <p className="ap-hint">Add an active staff member before scheduling an appointment.</p>}
      {canManage && !formReady && (
        <p className="ap-hint">{!canCustomers || !canLocations ? 'Scheduling an appointment also needs permission to view customers and staff. Ask the business owner to change your role.' : 'The scheduling form could not be loaded. Reload to try again.'}</p>
      )}

      <form className="ap-row" method="get" aria-label="Filter appointments">
        <input type="hidden" name="view" value={q.view} />
        <div className="ap-field"><label htmlFor="filter-type">Type</label><select id="filter-type" name="type" defaultValue={q.type ?? ''}>
          <option value="">All types</option>{APPOINTMENT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select></div>
        {staff?.ok && <div className="ap-field"><label htmlFor="filter-staff">Staff</label><select id="filter-staff" name="assignedMembershipId" defaultValue={q.assignedMembershipId ?? ''}>
          <option value="">All staff</option>{staff.data.filter((member) => member.status === 'Active').map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}
        </select></div>}
        <div className="ap-actions"><button className="ap-btn ap-btn-quiet" type="submit">Apply filters</button><Link className="ap-btn ap-btn-quiet" href="/fittings">Clear</Link></div>
      </form>

      <nav className="ap-tabs" aria-label="Appointment list">
        <Link href={fittingsHref(q, { view: 'upcoming', page: 1 })} aria-current={q.view === 'upcoming' ? 'page' : undefined}>Upcoming</Link>
        <Link href={fittingsHref(q, { view: 'all', page: 1 })} aria-current={q.view === 'all' ? 'page' : undefined}>All</Link>
      </nav>

      <section className="ap-panel" aria-label="Appointments">
        {items.length === 0 ? (
          <p style={{ margin: 0 }}>
            {totalCount > 0 ? <>No appointments on this page. <Link href={fittingsHref(q, { page: 1 })}>Go to the first page</Link>.</> : q.view === 'upcoming' ? 'No upcoming appointments.' : 'No appointments yet.'}
          </p>
        ) : (
          <div className="ap-scroll">
            <table className="ap-table">
              <thead><tr><th>Customer</th><th>Type</th><th>When</th><th>Duration</th><th>Staff</th>{locationList && <th>Location</th>}<th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
              <tbody>
                {items.map((appointment) => {
                  const name = customerNames.get(appointment.customerId) ?? 'Customer';
                  const staffName = formStaff.find((member) => member.id === appointment.assignedMembershipId)?.label ?? 'Unassigned';
                  const tone = fittingStatusTone(appointment.status);
                  const duration = Math.round((Date.parse(appointment.endUtc) - Date.parse(appointment.startUtc)) / 60_000);
                  return (
                    <tr key={appointment.id} className={appointment.status === 'Cancelled' || appointment.status === 'NoShow' ? 'ap-dim' : undefined}>
                      <td>
                        {canCustomers ? <Link href={`/customers/${appointment.customerId}`}><strong>{name}</strong></Link> : <strong>{name}</strong>}
                        {appointment.orderId && <div className="ap-foot"><Link href={`/orders/${appointment.orderId}`}>View order</Link></div>}
                        {appointment.notes && <div className="ap-foot ap-pre">{appointment.notes}</div>}
                        {appointment.cancellationReason && <div className="ap-foot ap-pre">Cancelled: {appointment.cancellationReason}</div>}
                      </td>
                      <td>{appointment.type}</td>
                      <td>{formatDateTime(appointment.startUtc, appointment.timeZoneId)}</td>
                      <td>{duration} min</td>
                      <td>{staffName}</td>
                      {locationList && <td>{locationNames.get(appointment.locationId) ?? '—'}</td>}
                      <td>
                        <span className={`ap-badge${tone === 'on' ? ' ap-badge-on' : tone === 'off' ? ' ap-badge-off' : ''}`} style={{ marginLeft: 0 }}>{fittingStatusLabel(appointment.status)}</span>
                        {needsOutcome({ status: appointment.status, scheduledAtUtc: appointment.startUtc, durationMinutes: duration }, now) && <span className="ap-badge ap-badge-off">Record outcome</span>}
                      </td>
                      {canManage && <td><AppointmentActions appointment={appointment} timeZone={appointment.timeZoneId} who={name} /></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {totalCount > 0 && (
          <nav className="ap-row ap-pager" aria-label="Pages">
            <span className="ap-hint">{totalCount} appointment{totalCount === 1 ? '' : 's'} · page {Math.min(q.page, pages)} of {pages}</span>
            <span className="ap-actions">
              {q.page > 1 && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={fittingsHref(q, { page: q.page - 1 })} rel="prev">Previous</Link>}
              {q.page < pages && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={fittingsHref(q, { page: q.page + 1 })} rel="next">Next</Link>}
            </span>
          </nav>
        )}
      </section>
      {q.view === 'upcoming' && <p className="ap-foot">Fittings from earlier days that were never closed out are under All.</p>}
    </div>
  );
}
