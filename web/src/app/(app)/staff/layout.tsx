import { PageHead } from '@/components/app/PageHead';
import { StaffTabs } from '@/components/app/StaffTabs';
import { getSession } from '@/lib/session';

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const me = (await getSession())!;
  return (
    <>
      <PageHead title="Team" intro="The people and permissions behind every well-made piece." zone={me.timeZoneId} />
      <StaffTabs />
      {children}
    </>
  );
}
