import { PageHead } from '@/components/app/PageHead';
import { NoAccess, LoadError } from '@/components/app/Notices';
import { WorkflowManager } from '@/components/app/WorkflowManager';
import { can } from '@/lib/team';
import { getSession, serverGet } from '@/lib/session';

export const metadata = { title: 'Production templates · Avzar' };
export const dynamic = 'force-dynamic';

type Stage = { key: string; name: string; instructions: string | null; requiredSkill: string | null; defaultMinutes: number | null; isConditional: boolean; completionChecks: string[]; dependsOn: string[] };
type Workflow = { id: string; name: string; description: string | null; isDefault: boolean; isActive: boolean; garmentCategories: string[]; stages: Stage[] };

export default async function WorkflowsPage() {
  const me = (await getSession())!;
  if (!can(me, 'workflows.manage')) return <NoAccess />;
  const result = await serverGet<Workflow[]>('/api/workflows?includeInactive=true');
  if (!result.ok) return <LoadError status={result.status} />;
  return <div className="ap-stack"><PageHead title="Production templates" intro="Configure task stages and quality checks for this shop." zone={me.timeZoneId} /><WorkflowManager initial={result.data} /></div>;
}
