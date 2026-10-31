import { PageHead } from '@/components/app/PageHead';
import { SettingsTabs } from '@/components/app/SettingsTabs';
import { StorefrontAnalyticsManager } from '@/components/app/StorefrontAnalyticsManager';
import { NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';
import type { AnalyticsSummary } from '@/lib/storefront-analytics-view-model';

export const metadata = { title: 'Storefront analytics · Avzar' };
export const dynamic = 'force-dynamic';

export default async function StorefrontAnalyticsPage() {
  const me = (await getSession())!;
  if (!can(me, 'business.settings')) return <NoAccess />;
  const summary = await serverGet<AnalyticsSummary>('/api/business/storefront-analytics/summary?days=30');
  return (
    <div className="ap-stack">
      <PageHead title="Storefront analytics" intro="Who visits your online shop, over the last 30 days." zone={me.timeZoneId} />
      <SettingsTabs />
      <StorefrontAnalyticsManager initial={summary.ok ? summary.data : null} />
    </div>
  );
}
