import { PageHead } from '@/components/app/PageHead';
import { DesignCatalogManager } from '@/components/app/DesignCatalogManager';
import { CollectionCsvTools } from '@/components/app/CollectionCsvTools';
import { NoAccess } from '@/components/app/Notices';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Design catalog · Avzar' };
export const dynamic = 'force-dynamic';

export default async function CatalogPage() {
  const me = (await getSession())!;
  const canView = can(me, 'designs.view');
  if (!canView) return <NoAccess />;
  return <div className="ap-stack"><PageHead title="Design catalog" intro="Import and export design data, review row-level CSV errors, and apply bulk catalog changes." zone={me.timeZoneId} /><DesignCatalogManager canManage={can(me, 'designs.manage')} /><CollectionCsvTools canManage={can(me, 'designs.manage')} /></div>;
}
