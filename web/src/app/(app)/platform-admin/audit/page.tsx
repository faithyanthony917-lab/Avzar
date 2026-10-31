import { PageHead } from '@/components/app/PageHead';
import { PlatformAdminNav } from '@/components/app/PlatformAdminNav';
import { PlatformAuditList } from '@/components/app/PlatformAuditList';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import type { PlatformAuditPage } from '@/lib/platformAdmin';

export const metadata = { title: 'Audit log · Platform · Avzar' };
export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function startOfDay(value: string): string | null { return DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? `${value}T00:00:00Z` : null; }
/** The "to" day is inclusive, and the route's upper bound is exclusive, so it is the start of the next day. */
function endOfDay(value: string): string | null {
  const start = startOfDay(value);
  return start ? new Date(Date.parse(start) + 86_400_000).toISOString() : null;
}

export default async function PlatformAuditPage({ searchParams }: { searchParams: Promise<{ action?: string; actor?: string; from?: string; to?: string; before?: string }> }) {
  const me = (await getSession())!;
  const sp = await searchParams;
  const filters = { action: (sp.action ?? '').trim(), actor: (sp.actor ?? '').trim(), from: sp.from && startOfDay(sp.from) ? sp.from : '', to: sp.to && startOfDay(sp.to) ? sp.to : '' };
  const query = new URLSearchParams({ limit: '25' });
  if (filters.action) query.set('action', filters.action);
  if (filters.actor) query.set('actor', filters.actor);
  if (filters.from) query.set('from', startOfDay(filters.from)!);
  if (filters.to) query.set('to', endOfDay(filters.to)!);
  if (sp.before) query.set('before', sp.before);
  const res = await serverGet<PlatformAuditPage>(`/api/platform-admin/audit-logs?${query.toString()}`);
  if (!res.ok) return res.status === 401 || res.status === 403 ? <NoAccess /> : <LoadError status={res.status} />;
  return (
    <div className="ap-stack">
      <PageHead title="Platform audit log" intro="What platform administrators changed or looked up. Entries are kept." zone={me.timeZoneId} />
      <PlatformAdminNav current="/platform-admin/audit" />
      <PlatformAuditList page={res.data} filters={filters} />
    </div>
  );
}
