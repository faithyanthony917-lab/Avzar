import { PageHead } from '@/components/app/PageHead';
import { NoAccess } from '@/components/app/Notices';
import { ShopSchedulePreview } from '@/components/app/ShopSchedulePreview';
import { getSession } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Shop schedule · Avzar' };
export const dynamic = 'force-dynamic';

export default async function ShopSchedulePage({ searchParams }: { searchParams: Promise<{ replan?: string; order?: string }> }) {
  const me = (await getSession())!;
  const query = await searchParams;
  const amendmentReplan = query.replan === 'order-amendment';
  const orderNumber = typeof query.order === 'string' ? query.order.slice(0, 80) : '';
  if (!can(me, 'tasks.view')) return <NoAccess />;
  return <div className="ap-stack">
    <PageHead title="Shop schedule" intro="Preview a task plan across your shop before applying any changes." zone={me.timeZoneId} />
    {amendmentReplan && <section className="ap-panel ap-stack" role="status"><h2 className="ap-h2">Order amendment needs a new schedule</h2><p style={{ margin: 0 }}>{orderNumber ? `Order ${orderNumber} was amended. ` : 'The order was amended. '}Unstarted task slots were cleared so the planner can calculate a fresh plan. Generate a preview, resolve any unscheduled tasks, then explicitly apply the replacement schedule. The amendment itself did not publish new times.</p></section>}
    <ShopSchedulePreview timeZoneId={me.timeZoneId} />
  </div>;
}
