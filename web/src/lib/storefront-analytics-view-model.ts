export type AnalyticsDay = { day: string; views: number };
export type AnalyticsPath = { path: string; views: number };
export type AnalyticsSummary = {
  enabled: boolean;
  days: number;
  fromDay: string;
  toDay: string;
  storefronts: { id: string; name: string; slug: string }[];
  storefrontId: string | null;
  totalViews: number;
  daily: AnalyticsDay[];
  topPaths: AnalyticsPath[];
  consent: { accepted: number; rejected: number };
};

export const SUMMARY_WINDOWS = [7, 30, 90] as const;

export type SummaryState = 'off' | 'empty' | 'data';

/** off: the switch is off and nothing has ever been counted; empty: no views in this window; data: there is something to show. */
export function summaryState(summary: Pick<AnalyticsSummary, 'enabled' | 'totalViews' | 'consent'>): SummaryState {
  const hasHistory = summary.totalViews > 0 || summary.consent.accepted + summary.consent.rejected > 0;
  if (!summary.enabled && !hasHistory) return 'off';
  return summary.totalViews > 0 ? 'data' : 'empty';
}

/** Bar heights as whole percentages of the busiest day, with a visible minimum for any day that has views. */
export function barPercents(daily: AnalyticsDay[]): number[] {
  const max = daily.reduce((top, entry) => Math.max(top, entry.views), 0);
  if (max <= 0) return daily.map(() => 0);
  return daily.map((entry) => (entry.views <= 0 ? 0 : Math.max(4, Math.round((entry.views / max) * 100))));
}

/** Share of recorded choices that were acceptances, as a whole percentage, or null when nobody has chosen yet. */
export function acceptanceRate(consent: { accepted: number; rejected: number }): number | null {
  const total = consent.accepted + consent.rejected;
  return total > 0 ? Math.round((consent.accepted / total) * 100) : null;
}

export function summaryPath(days: number, storefrontId: string | null): string {
  const params = new URLSearchParams({ days: String(days) });
  if (storefrontId) params.set('storefrontId', storefrontId);
  return `/api/business/storefront-analytics/summary?${params.toString()}`;
}
