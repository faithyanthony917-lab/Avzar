import { PageHead } from '@/components/app/PageHead';
import { SettingsTabs } from '@/components/app/SettingsTabs';
import { BillingManager } from '@/components/app/BillingManager';
import { LoadError, NoAccess } from '@/components/app/Notices';
import { getSession, serverGet } from '@/lib/session';
import { isCheckoutReturn } from '@/lib/billing-view-model';
import { can } from '@/lib/team';
import { planFromQuery } from '@/lib/storefront-guided';
export const metadata={title:'Subscription billing · Avzar'};export const dynamic='force-dynamic';
type Plan={code:string;name:string;description:string|null;currencyCode:string;monthlyPrice:number;annualPrice:number|null;entitlements:Record<string,string>};
type Catalog={entitlements:unknown[];plans:Plan[]};type Current={planCode:string;planName:string;status:string;currentPeriodEndUtc:string|null;trialEndsAtUtc:string|null;graceEndsAtUtc:string|null;suspendedAtUtc:string|null;suspendedPlanCode:string|null;pendingPlanCode:string|null;pendingPlanName:string|null;trialDays:number;canStartTrial:boolean;items:{key:string;value:string;description:string;used:number|null;overLimit?:boolean}[]};
export default async function BillingPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){const query=await searchParams;const returned=isCheckoutReturn(query);const wanted=planFromQuery(query.plan);const me=(await getSession())!;if(!can(me,'business.settings'))return <NoAccess/>;const [catalog,current]=await Promise.all([serverGet<Catalog>('/api/plans'),serverGet<Current>('/api/billing/entitlements')]);if(!catalog.ok)return <LoadError status={catalog.status}/>;if(!current.ok)return <LoadError status={current.status}/>;return <div className="ap-stack"><PageHead title="Subscription billing" intro="Your plan, what it includes and how you pay." zone={me.timeZoneId}/><SettingsTabs/><BillingManager catalog={catalog.data} current={current.data} returnedFromCheckout={returned} highlightPlan={wanted}/></div>;}
