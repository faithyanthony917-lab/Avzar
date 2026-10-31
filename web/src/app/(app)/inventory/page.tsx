import { PageHead } from '@/components/app/PageHead';
import { InventoryManager } from '@/components/app/InventoryManager';
import { NoAccess } from '@/components/app/Notices';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';
export const metadata={title:'Inventory · Avzar'}; export const dynamic='force-dynamic';
export default async function InventoryPage(){const me=(await getSession())!;if(!can(me,'inventory.view')&&!can(me,'inventory.manage'))return <NoAccess/>;return <div className="ap-stack"><PageHead title="Inventory" intro="Track fabrics and supplies, monitor reorder levels, and reserve, release or consume stock with a movement history in the backend." zone={me.timeZoneId} /><InventoryManager canManage={can(me,'inventory.manage')} timeZoneId={me.timeZoneId}/></div>;}
