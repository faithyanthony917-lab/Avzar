import { PageHead } from '@/components/app/PageHead';
import { AiStudio } from '@/components/app/AiStudio';
import { NoAccess } from '@/components/app/Notices';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';
export const metadata={title:'AI studio · Avzar'}; export const dynamic='force-dynamic';
export default async function AiStudioPage(){const me=(await getSession())!;const canDesign=can(me,'designs.manage');const canBuildAssistant=can(me,'storefront.edit');if(!canDesign&&!canBuildAssistant)return <NoAccess/>;return <div className="ap-stack"><PageHead title="AI studio" intro="Fashion concept generation and storefront assistant configuration. Access depends on permissions and your plan's AI entitlements." zone={me.timeZoneId} /><AiStudio canDesign={canDesign} canBuildAssistant={canBuildAssistant} canSave={can(me,'media.manage')}/></div>;}
