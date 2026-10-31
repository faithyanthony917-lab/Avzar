import { PageHead } from '@/components/app/PageHead';
import { PlatformPlanManager } from '@/components/app/PlatformPlanManager';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
export const metadata={title:'Platform plan administration · Avzar'};export const dynamic='force-dynamic';
type Plan={id:string;code:string;name:string;description:string|null;isActive:boolean;sortOrder:number;currencyCode:string;monthlyPrice:number;annualPrice:number|null;entitlements:Record<string,string>};
export default async function PlatformPlansPage(){const me=(await getSession())!;const res=await serverGet<Plan[]>('/api/platform-admin/plans');if(!res.ok){if(res.status===401||res.status===403)return <NoAccess/>;return <LoadError status={res.status}/>;}return <div className="ap-stack"><PageHead title="Platform plans" intro="Plans, prices and what each plan includes." zone={me.timeZoneId} /><PlatformPlanManager initial={res.data}/></div>;}
