import { PageHead } from '@/components/app/PageHead';
import Link from 'next/link';
import { InquiryActions, type InquiryFormData } from '@/components/app/InquiryActions';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { Paged } from '@/lib/customer-types';
import { totalPages } from '@/lib/customers';
import { formatDate, formatDateTime } from '@/lib/dates';
import {
  INQUIRIES_PAGE_SIZE, INQUIRY_KINDS, INQUIRY_STATUSES, dayOf, inquiriesApiQuery, inquiriesHref, inquiryKindLabel, inquiryOutcome, inquiryStatusTone,
  parseInquiriesQuery, type Inquiry,
} from '@/lib/inquiries-view-model';
import { getSession, serverGet } from '@/lib/session';
import type { Location, StaffMember } from '@/lib/staff-types';
import { can } from '@/lib/team';

export const metadata = { title: 'Requests · Avzar' };
export const dynamic = 'force-dynamic';

export default async function InquiriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = (await getSession())!;
  if (!can(me, 'inquiries.view')) return <NoAccess />;
  const q = parseInquiriesQuery(await searchParams);
  const canManage = can(me, 'inquiries.manage');
  const canBook = canManage && can(me, 'fittings.manage');
  const canLocations = can(me, 'staff.view');

  // The list needs only inquiries.view. The forms need the locations and staff lists (staff.view).
  const [inquiries, locations, staff] = await Promise.all([
    serverGet<Paged<Inquiry>>(`/api/inquiries?${inquiriesApiQuery(q)}`),
    canManage && canLocations ? serverGet<Location[]>('/api/locations') : null,
    canManage && canLocations ? serverGet<StaffMember[]>('/api/staff') : null,
  ]);
  if (!inquiries.ok) return <LoadError status={inquiries.status} />;

  const canAssignAllLocations = me.isOwner || can(me, 'locations.all');
  const allowedIds = canAssignAllLocations ? null : new Set(staff?.ok ? staff.data.find((m) => m.userId === me.userId)?.locationIds ?? [] : []);
  const form: InquiryFormData | null = locations?.ok && staff?.ok ? {
    locations: locations.data.filter((l) => l.isActive && (allowedIds === null || allowedIds.has(l.id))).map((l) => ({ id: l.id, label: l.name })),
    staff: staff.data.filter((m) => m.status === 'Active').map((m) => ({ id: m.membershipId, label: m.displayName, isOwner: m.isOwner, locationIds: m.locationIds })),
    canAssignAllLocations,
    currentMembershipId: staff.data.find((m) => m.userId === me.userId)?.membershipId ?? null,
  } : null;

  const { items, totalCount } = inquiries.data;
  const pages = totalPages(totalCount, inquiries.data.pageSize || INQUIRIES_PAGE_SIZE);
  const filtered = !!q.status || !!q.kind;

  return (
    <div className="ap-stack">
      <PageHead title="Requests" intro={`Messages, booking requests and order requests that customers send through your storefront. Times are shown in ${me.timeZoneId}.`} zone={me.timeZoneId} />
      {canManage && !form && <p className="ap-hint">{canLocations ? 'The scheduling and order forms could not be loaded. Reload to try again.' : 'Scheduling an appointment or creating an order also needs permission to view staff and locations. Ask the business owner to change your role.'}</p>}

      <form className="ap-row" method="get" aria-label="Filter requests">
        <div className="ap-field"><label htmlFor="filter-status">Status</label><select id="filter-status" name="status" defaultValue={q.status ?? ''}>
          <option value="">All statuses</option>{INQUIRY_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select></div>
        <div className="ap-field"><label htmlFor="filter-kind">Kind</label><select id="filter-kind" name="kind" defaultValue={q.kind ?? ''}>
          <option value="">All kinds</option>{INQUIRY_KINDS.map((value) => <option key={value} value={value}>{inquiryKindLabel(value)}</option>)}
        </select></div>
        <div className="ap-actions"><button className="ap-btn ap-btn-quiet" type="submit">Apply filters</button><Link className="ap-btn ap-btn-quiet" href="/inquiries">Clear</Link></div>
      </form>

      <section className="ap-panel ap-stack" aria-label="Requests">
        {items.length === 0 ? (
          <p style={{ margin: 0 }}>
            {totalCount > 0 ? <>No requests on this page. <Link href={inquiriesHref(q, { page: 1 })}>Go to the first page</Link>.</> : filtered ? 'No requests match these filters.' : 'No requests yet. They appear here when a customer sends one from your storefront.'}
          </p>
        ) : (
          <ul className="ap-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item) => {
              const tone = inquiryStatusTone(item.status);
              const outcome = inquiryOutcome(item);
              const preferred = dayOf(item.preferredDate);
              const event = dayOf(item.eventDate);
              return (
                <li key={item.id} className="ap-panel ap-stack" aria-label={`${inquiryKindLabel(item.kind)} from ${item.name}`}>
                  <div className="ap-row">
                    <strong>{item.name}</strong>
                    <span className="ap-badge" style={{ marginLeft: 0 }}>{inquiryKindLabel(item.kind)}</span>
                    <span className={`ap-badge${tone === 'on' ? ' ap-badge-on' : tone === 'off' ? ' ap-badge-off' : ''}`} style={{ marginLeft: 0 }}>{item.status}</span>
                    <span className="ap-foot">{formatDateTime(item.createdAtUtc, me.timeZoneId)}</span>
                  </div>
                  <p className="ap-pre" style={{ margin: 0 }}>{item.message}</p>
                  <div className="ap-foot">
                    {[item.email, item.phone].filter(Boolean).join(' · ')}
                    {item.designName && <> · Design: {item.designName}</>}
                    {item.garmentType && <> · {item.garmentType}</>}
                    {item.budget && <> · Budget: {item.budget}</>}
                    {preferred && <> · Preferred day: {formatDate(`${preferred}T12:00:00Z`, 'UTC')}</>}
                    {event && <> · Event: {formatDate(`${event}T12:00:00Z`, 'UTC')}</>}
                  </div>
                  {item.internalNote && <div className="ap-foot ap-pre">Note: {item.internalNote}</div>}
                  {outcome && (
                    <div className="ap-foot">
                      {outcome}
                      {item.convertedOrderId && <> · <Link href={`/orders/${item.convertedOrderId}`}>View order</Link></>}
                      {item.appointmentId && <> · <Link href="/fittings?view=all">View appointments</Link></>}
                    </div>
                  )}
                  <InquiryActions inquiry={item} timeZone={me.timeZoneId} canManage={canManage} canBook={canBook} form={form} />
                </li>
              );
            })}
          </ul>
        )}
        {totalCount > 0 && (
          <nav className="ap-row ap-pager" aria-label="Pages">
            <span className="ap-hint">{totalCount} request{totalCount === 1 ? '' : 's'} · page {Math.min(q.page, pages)} of {pages}</span>
            <span className="ap-actions">
              {q.page > 1 && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={inquiriesHref(q, { page: q.page - 1 })} rel="prev">Previous</Link>}
              {q.page < pages && <Link className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} href={inquiriesHref(q, { page: q.page + 1 })} rel="next">Next</Link>}
            </span>
          </nav>
        )}
      </section>
    </div>
  );
}
