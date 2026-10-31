'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import { parseWorkflowStages } from '@/lib/production-workflows';
import { Pager, usePaged } from './Pager';
import { toast } from '@/lib/toast';

type Stage = {
  key: string; name: string; instructions?: string | null; requiredSkill?: string | null;
  defaultMinutes?: number | null; isConditional?: boolean; completionChecks?: string[]; dependsOn?: string[];
};
type Workflow = {
  id: string; name: string; description: string | null; isDefault: boolean; isActive: boolean;
  garmentCategories: string[]; stages: Stage[];
};
type Draft = Omit<Workflow, 'id' | 'stages'> & { id?: string; stages: Stage[] };
const starterStage: Stage = { key: 'sewing', name: 'Sewing', instructions: '', requiredSkill: 'sewing', defaultMinutes: 120, isConditional: false, completionChecks: ['Seams inspected'], dependsOn: [] };
const emptyDraft = (): Draft => ({ name: '', description: '', isDefault: false, isActive: true, garmentCategories: [], stages: [{ ...starterStage, completionChecks: [...(starterStage.completionChecks ?? [])] }] });

export function WorkflowManager({ initial }: { initial: Workflow[] }) {
  const [workflows, setWorkflows] = useState(initial);
  const [draft, setDraft] = useState<Draft>(initial[0] ? { ...initial[0], stages: initial[0].stages.map((s) => ({ ...s })) } : emptyDraft());
  const [stages, setStages] = useState<Stage[]>(draft.stages);
  const pagedStages = usePaged(stages, 5);
  const [categories, setCategories] = useState(draft.garmentCategories.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  
  function selectWorkflow(id: string) {
    const found = workflows.find((item) => item.id === id);
    const next = found ? { ...found, stages: found.stages.map((s) => ({ ...s })) } : emptyDraft();
    setDraft(next); setStages(next.stages); setCategories(next.garmentCategories.join(', '));
    setError('');
  }

  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40);
  function patchStage(index: number, patch: Partial<Stage>) {
    setStages((old) => {
      const prev = old[index]?.key;
      const next = old.map((st, i) => (i === index ? { ...st, ...patch } : st));
      // Renaming a stage key keeps every "needs first" link pointing at it.
      if (patch.key !== undefined && prev !== undefined && patch.key !== prev) return next.map((st) => ({ ...st, dependsOn: (st.dependsOn ?? []).map((k) => (k === prev ? patch.key! : k)) }));
      return next;
    });
  }
  function addStage() {
    setStages((old) => [...old, { key: `stage_${old.length + 1}`, name: '', instructions: '', requiredSkill: '', defaultMinutes: 60, isConditional: false, completionChecks: [], dependsOn: [] }]);
    pagedStages.setPage(Math.ceil((stages.length + 1) / 5));
  }
  function removeStage(index: number) {
    setStages((old) => {
      const gone = old[index]?.key;
      return old.filter((_, i) => i !== index).map((st) => ({ ...st, dependsOn: (st.dependsOn ?? []).filter((k) => k !== gone) }));
    });
  }
  function moveStage(index: number, by: -1 | 1) {
    setStages((old) => { const to = index + by; if (to < 0 || to >= old.length) return old; const copy = [...old]; const [item] = copy.splice(index, 1); copy.splice(to, 0, item!); return copy; });
  }

  async function save() {
    setBusy(true); setError('');
    let checked: Stage[];
    try { checked = parseWorkflowStages(JSON.stringify(stages)) as Stage[]; }
    catch (e) { toast.error(e instanceof Error ? e.message.replace('Stages must be a JSON array containing', 'A template needs') : 'The stages are not valid.'); setBusy(false); return; }
    checked = checked.map((st) => ({ ...st, instructions: st.instructions?.trim() || null, requiredSkill: st.requiredSkill?.trim() || null, completionChecks: (st.completionChecks ?? []).map((c) => c.trim()).filter(Boolean) }));
    const keys = checked.map((st) => st.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) { setError(`Two stages share the key "${dup}". Each stage needs its own key.`); setBusy(false); return; }
    try {
      const payload = { name: draft.name, description: draft.description || null, isDefault: draft.isDefault, isActive: draft.isActive,
        garmentCategories: categories.split(',').map((s) => s.trim()).filter(Boolean), stages: checked };
      const saved = await api<Workflow>(draft.id ? `/api/workflows/${draft.id}` : '/api/workflows', { method: draft.id ? 'PUT' : 'POST', json: payload });
      setWorkflows((old) => [...old.filter((w) => w.id !== saved.id).map((w) => saved.isDefault ? { ...w, isDefault: false } : w), saved].sort((a, b) => a.name.localeCompare(b.name)));
      setDraft(saved); setStages(saved.stages.map(({ key, name, instructions, requiredSkill, defaultMinutes, isConditional, completionChecks, dependsOn }) => ({ key, name, instructions, requiredSkill, defaultMinutes, isConditional, completionChecks, dependsOn })));
      setCategories(saved.garmentCategories.join(', ')); toast.success('Workflow saved. It will be used for future task generation; existing tasks are unchanged.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Workflow could not be saved.'); }
    finally { setBusy(false); }
  }

  return <div className="ap-stack">
    <section className="ap-panel ap-stack" aria-labelledby="workflow-list-title">
      <div className="ap-row"><h2 id="workflow-list-title" className="ap-h2">Shop task templates</h2><button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => selectWorkflow('')}>New template</button></div>
      {workflows.length === 0 ? <p>No templates saved yet. Create one below; it becomes the default if it is the first template.</p> : <div className="ap-field"><label htmlFor="workflow-select">Edit template</label><select id="workflow-select" className="ap-input" value={draft.id ?? ''} onChange={(e) => selectWorkflow(e.target.value)}><option value="" disabled>Select a template</option>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' · Default' : ''}{!w.isActive ? ' · Inactive' : ''}</option>)}</select></div>}
    </section>
    <section className="ap-panel ap-stack" aria-labelledby="workflow-editor-title">
      <h2 id="workflow-editor-title" className="ap-h2">{draft.id ? 'Edit task template' : 'Create task template'}</h2>
      {error && <p className="ap-alert" role="alert">{error}</p>}
      <div className="ap-field"><label htmlFor="workflow-name">Template name</label><input id="workflow-name" className="ap-input" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} minLength={2} maxLength={80} required /></div>
      <div className="ap-field"><label htmlFor="workflow-description">Description</label><input id="workflow-description" className="ap-input" value={draft.description ?? ''} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} maxLength={500} /></div>
      <div className="ap-field"><label htmlFor="workflow-categories">Garment categories (comma separated)</label><input id="workflow-categories" className="ap-input" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="Shirt, Trousers, Dress / Gown" maxLength={2000} /><p className="ap-foot">Leave empty to make this template available as a fallback. Categories are matched to garment categories on future orders.</p></div>
      <label className="ap-check"><input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft((d) => ({ ...d, isDefault: e.target.checked }))} /> Default workflow for unmatched garments</label>
      <label className="ap-check"><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft((d) => ({ ...d, isActive: e.target.checked }))} /> Active for new orders</label>
      <div className="ap-stack" role="group" aria-labelledby="workflow-stages-title">
        <div className="ap-row"><h3 id="workflow-stages-title" className="ap-h3">Stages ({stages.length})</h3><button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={stages.length >= 30} onClick={addStage}>Add stage</button></div>
        <p className="ap-foot">Stages run in the order listed. Use “Needs first” when a stage cannot start until another one is finished.</p>
        {pagedStages.slice.map((st, k) => {
          const index = (pagedStages.page - 1) * pagedStages.size + k;
          const others = stages.filter((_, i) => i !== index);
          return <div key={index} className="ap-stagecard">
            <div className="ap-row"><strong>{index + 1}. {st.name || 'New stage'}</strong>
              <div className="ap-actions">
                <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={index === 0} aria-label={`Move stage ${index + 1} up`} onClick={() => moveStage(index, -1)}>Up</button>
                <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={index === stages.length - 1} aria-label={`Move stage ${index + 1} down`} onClick={() => moveStage(index, 1)}>Down</button>
                <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" disabled={stages.length <= 1} aria-label={`Remove stage ${index + 1}`} onClick={() => removeStage(index)}>Remove</button>
              </div>
            </div>
            <div className="ap-grid2">
              <div className="ap-field"><label htmlFor={`stage-name-${index}`}>Stage name</label><input id={`stage-name-${index}`} className="ap-input" value={st.name} maxLength={80} placeholder="e.g. Cutting" onChange={(e) => { const name = e.target.value; patchStage(index, { name, ...(st.key.startsWith('stage_') || st.key === slug(st.name) ? { key: slug(name) || st.key } : {}) }); }} /></div>
              <div className="ap-field"><label htmlFor={`stage-minutes-${index}`}>Usual time (minutes)</label><input id={`stage-minutes-${index}`} className="ap-input" type="number" min={1} max={100000} value={st.defaultMinutes ?? ''} onChange={(e) => patchStage(index, { defaultMinutes: e.target.value === '' ? null : Math.max(1, Math.round(Number(e.target.value))) })} /></div>
              <div className="ap-field"><label htmlFor={`stage-skill-${index}`}>Skill needed (optional)</label><input id={`stage-skill-${index}`} className="ap-input" value={st.requiredSkill ?? ''} maxLength={60} placeholder="e.g. sewing" onChange={(e) => patchStage(index, { requiredSkill: e.target.value })} /></div>
              <div className="ap-field"><label htmlFor={`stage-key-${index}`}>Stage key</label><input id={`stage-key-${index}`} className="ap-input" value={st.key} maxLength={40} onChange={(e) => patchStage(index, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} /><p className="ap-foot">A short lowercase id. Other stages use it to say what they wait for.</p></div>
            </div>
            <div className="ap-field"><label htmlFor={`stage-notes-${index}`}>Instructions (optional)</label><textarea id={`stage-notes-${index}`} className="ap-input" rows={2} value={st.instructions ?? ''} maxLength={1000} onChange={(e) => patchStage(index, { instructions: e.target.value })} /></div>
            <div className="ap-field"><label htmlFor={`stage-checks-${index}`}>Checks before it can be marked done (one per line)</label><textarea id={`stage-checks-${index}`} className="ap-input" rows={2} value={(st.completionChecks ?? []).join('\n')} placeholder="e.g. Seams inspected" onChange={(e) => patchStage(index, { completionChecks: e.target.value.split('\n') })} onBlur={(e) => patchStage(index, { completionChecks: e.target.value.split('\n').map((c) => c.trim()).filter(Boolean) })} /></div>
            {others.length > 0 && <fieldset className="ap-fieldset"><legend>Needs first</legend>{others.map((o) => <label key={o.key} className="ap-check"><input type="checkbox" checked={(st.dependsOn ?? []).includes(o.key)} onChange={(e) => patchStage(index, { dependsOn: e.target.checked ? [...(st.dependsOn ?? []), o.key] : (st.dependsOn ?? []).filter((k) => k !== o.key) })} /> {o.name || o.key}</label>)}</fieldset>}
            <label className="ap-check"><input type="checkbox" checked={!!st.isConditional} onChange={(e) => patchStage(index, { isConditional: e.target.checked })} /> Only needed for some garments (optional stage)</label>
          </div>;
        })}
        <Pager page={pagedStages.page} pages={pagedStages.pages} total={pagedStages.total} size={pagedStages.size} onPage={pagedStages.setPage} label="Stages pages" />
      </div>
      <div className="ap-actions"><button type="button" className="ap-btn" disabled={busy || draft.name.trim().length < 2} onClick={() => void save()}>{busy ? 'Saving…' : 'Save template'}</button></div>
      {busy && <p className="ap-foot" role="status">Saving workflow…</p>}
    </section>
  </div>;
}
