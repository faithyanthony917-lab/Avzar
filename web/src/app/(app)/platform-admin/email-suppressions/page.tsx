import { PageHead } from '@/components/app/PageHead';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';

export const metadata = { title: 'Email suppressions · Avzar' };
export const dynamic = 'force-dynamic';

type Suppression = { id: string; address: string; reason: string; createdAtUtc: string };
type Result = { items: Suppression[]; limit: number };

export default async function EmailSuppressionsPage() {
  const me = (await getSession())!;
  const res = await serverGet<Result>('/api/platform-admin/email-suppressions?limit=500');
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return <NoAccess />;
    return <LoadError status={res.status} />;
  }
  return <div className="ap-stack">
    <PageHead title="Email suppressions" intro="Platform-wide addresses blocked after permanent bounces or spam complaints. This screen is read-only to prevent accidental re-enabling of suppressed addresses." zone={me.timeZoneId} />
    <section className="ap-panel ap-stack">
      <div className="ap-row"><strong>{res.data.items.length} recent suppressed address(es)</strong><a className="ap-btn ap-btn-quiet" href="/platform-admin/plans">Platform plans</a></div>
      {res.data.items.length === 0 ? <p>No suppressed addresses were found.</p> : <div className="ap-scroll"><table className="ap-table"><thead><tr><th>Email address</th><th>Reason</th><th>Added</th></tr></thead><tbody>{res.data.items.map(item => <tr key={item.id}><td>{item.address}</td><td>{item.reason}</td><td>{new Date(item.createdAtUtc).toLocaleString()}</td></tr>)}</tbody></table></div>}
      <p className="ap-foot">Showing up to {res.data.limit} records. Provider webhooks add suppressions automatically; no manual delete action is exposed here.</p>
    </section>
  </div>;
}
