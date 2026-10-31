import { BrandingManager, type Branding } from '@/components/app/BrandingManager';
import { PaymentAccountPanel } from '@/components/app/PaymentAccountPanel';
import { MessageTemplatesPanel } from '@/components/app/MessageTemplatesPanel';
import { BusinessScheduleManager } from '@/components/app/BusinessScheduleManager';
import { PageHead } from '@/components/app/PageHead';
import { SettingsTabs } from '@/components/app/SettingsTabs';
import { SignOutButton } from '@/components/app/SignOutButton';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Business settings · Avzar' };
export const dynamic = 'force-dynamic';

type DayHours = { dayOfWeek: number; isOpen: boolean; opensAt: string | null; closesAt: string | null };
type Holiday = { id: string; date: string; name: string };
type BusinessSchedule = { timeZoneId: string; days: DayHours[]; holidays: Holiday[] };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tab = (await searchParams).tab === 'brand' ? 'brand' : 'details';
  const me = (await getSession())!;
  if (!can(me, 'business.settings')) return <NoAccess />;
  const schedule = await serverGet<BusinessSchedule>('/api/business/schedule');
  if (!schedule.ok) return <LoadError status={schedule.status} />;
  const branding = await serverGet<Branding>('/api/business/branding');
  const brandingPanel = branding.ok ? <BrandingManager initial={branding.data} /> : <p className="ap-alert" role="status">Document branding could not be loaded (HTTP {branding.status}).</p>;
  return (
    <div className="ap-stack">
      <PageHead title="Business settings" intro="The details that make this studio yours." zone={me.timeZoneId} />
      <SettingsTabs active={tab} />
      {tab === 'brand' ? (
        <BusinessScheduleManager initialSchedule={schedule.data} />
      ) : (
        <>
          <section className="ap-panel" aria-labelledby="studio-details">
            <h2 id="studio-details" className="ap-h2">Studio details</h2>
            <dl className="ap-dl">
              <dt>Studio name</dt>
              <dd>{me.businessName}</dd>
              <dt>Time zone</dt>
              <dd>{me.timeZoneId}</dd>
              <dt>Currency</dt>
              <dd>{me.currencyCode}</dd>
            </dl>
          </section>
          <PaymentAccountPanel />
          <MessageTemplatesPanel />
          {brandingPanel}
        </>
      )}
      <footer className="ap-settings-foot"><span>Signed in as {me.fullName}</span><SignOutButton /></footer>
    </div>
  );
}
