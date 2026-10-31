import Link from 'next/link';
import { LoadError } from '@/components/app/Notices';
import { longDate } from '@/lib/home-view';
import type { MeasurementTemplate } from '@/lib/measurement-types';
import { fieldCountText } from '@/lib/measurement-template-view-model';
import { serverGet } from '@/lib/session';

/** The "My Templates" tab of the Customers screen: every template, including inactive ones, with edit links for people who may manage them. */
export async function MeasurementTemplatesTab({ zone, canManage }: { zone: string; canManage: boolean }) {
  const res = await serverGet<MeasurementTemplate[]>('/api/measurement-templates?includeInactive=true');
  if (!res.ok) return <LoadError status={res.status} />;
  const templates = res.data;
  return (
    <>
      <header className="ap-pagehead">
        <div>
          <p className="ap-eyebrow">{longDate(zone)}</p>
          <h1>Customers</h1>
        </div>
      </header>

      <div className="ap-toolbar ap-cust-toolbar">
        <div className="ap-cust-tabs" role="group" aria-label="Customers">
          <Link href="/customers">Clients</Link>
          <Link href="/customers?tab=templates" aria-current="page">My Templates<span>{templates.length}</span></Link>
        </div>
        <div className="ap-actions">
          {canManage && (
            <Link href="/customers/templates/new" className="ap-btn ap-new-btn" style={{ textDecoration: 'none' }} aria-label="New template">
              <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M12 5v14M5 12h14" /></svg>New
            </Link>
          )}
        </div>
      </div>

      <section className="ap-stack" aria-label="Measurement templates">
        {templates.length === 0 ? (
          <p className="ap-panel" style={{ margin: 0 }}>
            No templates yet. A template lists the measurements you take for a kind of garment, such as a shirt or a gown.
            {canManage ? <> <Link href="/customers/templates/new">Create your first template</Link>.</> : ' Ask the studio owner to set one up.'}
          </p>
        ) : (
          <ul className="ap-plain ap-stack" role="list">
            {templates.map((t) => (
              <li key={t.id} className={t.isActive ? 'ap-panel' : 'ap-panel ap-dim'}>
                <div className="ap-row">
                  <div className="ap-grow">
                    <strong>{t.name}</strong>
                    {!t.isActive && <span className="ap-badge ap-badge-off" style={{ marginLeft: '.5rem' }}>Inactive</span>}
                    <p className="ap-foot" style={{ margin: 0 }}>{fieldCountText(t.fields.length)}{t.fields.length > 0 && ` · ${t.fields.slice(0, 4).map((f) => f.label).join(', ')}${t.fields.length > 4 ? '…' : ''}`}</p>
                    {t.description && <p className="ap-hint" style={{ margin: '.25rem 0 0' }}>{t.description}</p>}
                  </div>
                  {canManage && <Link href={`/customers/templates/${t.id}`} className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none' }} aria-label={`Edit ${t.name}`}>Edit</Link>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
