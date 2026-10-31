'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { MEASUREMENT_UNITS, type MeasurementTemplate, type MeasurementUnit } from '@/lib/measurement-types';
import {
  FIELD_LABEL_MAX, TEMPLATE_DESCRIPTION_MAX, TEMPLATE_FIELDS_MAX, TEMPLATE_NAME_MAX, blankField, fieldsFromTemplate, moveField,
  validateTemplateForm, type TemplateErrors, type TemplateFormField,
} from '@/lib/measurement-template-view-model';
import { ApiError, messageFor } from '@/lib/problem';
import { Field, SelectField, TextAreaField } from './Field';

const UNIT_OPTIONS = MEASUREMENT_UNITS.map((u) => ({ value: u, label: u }));
const NO_ERRORS: TemplateErrors = { byField: {} };

/** Create (no `template`) or edit (with `template`) a measurement template. */
export function MeasurementTemplateForm({ template }: { template?: MeasurementTemplate }) {
  const router = useRouter();
  const nextUid = useRef(0);
  const newUid = () => `new-${nextUid.current++}`;
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const [fields, setFields] = useState<TemplateFormField[]>(() => (template ? fieldsFromTemplate(template) : [{ ...blankField('new-start'), label: 'Chest' }]));
  const [errors, setErrors] = useState<TemplateErrors>(NO_ERRORS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (uid: string, change: Partial<TemplateFormField>) => setFields((list) => list.map((f) => (f.uid === uid ? { ...f, ...change } : f)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const check = validateTemplateForm({ name, description, isActive, fields });
    if (!check.ok) { setErrors(check.errors); setError('Please fix the highlighted fields.'); return; }
    setErrors(NO_ERRORS);
    setBusy(true);
    try {
      if (template) await api<MeasurementTemplate>(`/api/measurement-templates/${template.id}`, { method: 'PUT', json: check.body });
      else await api<MeasurementTemplate>('/api/measurement-templates', { method: 'POST', json: check.body });
      router.push('/customers?tab=templates');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'template_exists') setErrors({ byField: {}, name: 'A template with this name already exists.' });
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy} noValidate>
      <h2 className="ap-h2">{template ? 'Edit template' : 'New template'}</h2>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <Field id="t-name" label="Template name" required maxLength={TEMPLATE_NAME_MAX} autoComplete="off" value={name} onChange={setName} error={errors.name} hint="For example “Shirt” or “Agbada”." />
      <TextAreaField id="t-desc" label="Description (optional)" maxLength={TEMPLATE_DESCRIPTION_MAX} value={description} onChange={setDescription} error={errors.description} />
      <label className="ap-check"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active. Only active templates can be used to record new measurements.</label>

      <h3 className="ap-h2" style={{ marginBottom: 0 }}>Measurements</h3>
      {errors.fields && <p role="alert" className="ap-err">{errors.fields}</p>}
      <ul className="ap-plain ap-stack" aria-label="Measurements in this template">
        {fields.map((f, i) => {
          const fe = errors.byField[f.uid] ?? {};
          return (
            <li key={f.uid} className="ap-panel ap-stack">
              <div className="ap-grid2">
                <Field id={`t-label-${f.uid}`} label={`Measurement ${i + 1}`} maxLength={FIELD_LABEL_MAX} autoComplete="off" value={f.label} onChange={(v) => patch(f.uid, { label: v })} error={fe.label} />
                <SelectField id={`t-unit-${f.uid}`} label="Unit" value={f.unit} onChange={(v) => patch(f.uid, { unit: v as MeasurementUnit })} options={UNIT_OPTIONS} />
              </div>
              <div className="ap-grid2">
                <Field id={`t-min-${f.uid}`} label="Lowest allowed (optional)" inputMode="decimal" autoComplete="off" value={f.min} onChange={(v) => patch(f.uid, { min: v })} error={fe.min} />
                <Field id={`t-max-${f.uid}`} label="Highest allowed (optional)" inputMode="decimal" autoComplete="off" value={f.max} onChange={(v) => patch(f.uid, { max: v })} error={fe.max} />
              </div>
              <label className="ap-check"><input type="checkbox" checked={f.required} onChange={(e) => patch(f.uid, { required: e.target.checked })} /> Required when recording</label>
              <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
                <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={i === 0} aria-label={`Move measurement ${i + 1} up`} onClick={() => setFields((l) => moveField(l, i, -1))}>Up</button>
                <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={i === fields.length - 1} aria-label={`Move measurement ${i + 1} down`} onClick={() => setFields((l) => moveField(l, i, 1))}>Down</button>
                <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={fields.length === 1} aria-label={`Remove measurement ${i + 1}`} onClick={() => setFields((l) => l.filter((x) => x.uid !== f.uid))}>Remove</button>
              </div>
              {template && f.key && <p className="ap-hint" style={{ margin: 0 }}>Saved measurement. Renaming it keeps values already recorded; removing it drops it from new revisions.</p>}
            </li>
          );
        })}
      </ul>
      <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="ap-btn ap-btn-quiet" disabled={fields.length >= TEMPLATE_FIELDS_MAX} onClick={() => setFields((l) => [...l, blankField(newUid())])}>Add measurement</button>
      </div>

      <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
        <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Saving…' : template ? 'Save changes' : 'Create template'}</button>
        <Link href="/customers?tab=templates" className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Cancel</Link>
      </div>
    </form>
  );
}
