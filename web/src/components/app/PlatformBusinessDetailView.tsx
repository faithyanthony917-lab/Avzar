import { type PlatformBusinessDetail, bytes, when } from '@/lib/platformAdmin';
import { PlatformBusinessSuspension } from '@/components/app/PlatformBusinessSuspension';

export function PlatformBusinessDetailView({ business: b, isOwnBusiness = false }: { business: PlatformBusinessDetail; isOwnBusiness?: boolean }) {
  const rows: [string, string | number][] = [
    ['Active staff', b.usage.activeStaff], ['Locations', b.usage.locations], ['Customers', b.usage.customers],
    ['Orders', b.usage.orders], ['Orders in the last 30 days', b.usage.ordersLast30Days], ['Invoices', b.usage.invoices], ['Stored media', bytes(b.usage.storageBytes)],
  ];
  return (
    <div className="ap-stack">
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">Business</h2>
        <dl className="ap-stack" style={{ margin: 0 }}>
          <div><dt>Status</dt><dd>{b.isActive ? 'Active' : `Suspended${b.suspendedAtUtc ? ` on ${when(b.suspendedAtUtc)}` : ''}`}</dd></div>
          <div><dt>Contact email</dt><dd>{b.contactEmail ?? '—'}</dd></div>
          <div><dt>Owner</dt><dd>{b.owner ? `${b.owner.fullName} (${b.owner.email})` : '—'}</dd></div>
          <div><dt>Currency and time zone</dt><dd>{b.currencyCode}, {b.timeZoneId}</dd></div>
          <div><dt>Plan</dt><dd>{b.plan ? `${b.plan.name} (${b.plan.status}${b.plan.currentPeriodEndUtc ? `, period ends ${when(b.plan.currentPeriodEndUtc)}` : ''})` : 'No subscription'}</dd></div>
          <div><dt>Created</dt><dd>{when(b.createdAtUtc)}</dd></div>
        </dl>
      </section>
      <PlatformBusinessSuspension businessId={b.id} businessName={b.name} isActive={b.isActive} suspendedReason={b.suspendedReason ?? null} isOwnBusiness={isOwnBusiness} />
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">Usage</h2>
        <p className="ap-foot">Counts only. Customer names and contact details are never shown to platform administrators.</p>
        <div className="ap-scroll"><table className="ap-table"><tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}
