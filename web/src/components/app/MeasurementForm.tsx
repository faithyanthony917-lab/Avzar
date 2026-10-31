'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import type { MeasurementSet, MeasurementTemplate, MeasurementValue, NewMeasurementSetBody, NewRevisionBody } from '@/lib/measurement-types';
import {
  LABEL_MAX, NOTES_MAX, buildFormModel, rangeHint, revisionHasChange, validateLabel, validateNotes, validateValues,
} from '@/lib/measurement-view-model';
import { ApiError, messageFor } from '@/lib/problem';
import { Field, SelectField, TextAreaField } from './Field';

const NO_VALUES: MeasurementValue[] = [];

type Props =
  | { mode: 'new'; customerId: string; templates: MeasurementTemplate[] }
  | { mode: 'revise'; customerId: string; set: MeasurementSet; template: MeasurementTemplate };

/**
 * Records a new measurement profile (templates to pick from) or a new revision of one (template fixed, values pre-filled).
 * Validation mirrors validateMeasurementValues in backend-node/src/auth/customerRoutes.js; the server stays the authority.
 */
export function MeasurementForm(props: Props) {
  const router = useRouter();
  const revise = props.mode === 'revise';
  const [templateId, setTemplateId] = useState(props.mode === 'new' ? props.templates[0]?.id ?? '' : props.template.id);
  const template = props.mode === 'new' ? props.templates.find((t) => t.id === templateId) : props.template;
  const earlier: MeasurementValue[] = props.mode === 'revise' ? props.set.values : NO_VALUES;

  const model = useMemo(() => (template ? buildFormModel(template, earlier) : { fields: [], droppedKeys: [] }), [template, earlier]);
  const [raws, setRaws] = useState<Record<string, string>>(() => Object.fromEntries(model.fields.map((f) => [f.key, f.raw])));
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [labelError, setLabelError] = useState<string | undefined>();
  const [notesError, setNotesError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pickTemplate(id: string) {
    const next = props.mode === 'new' ? props.templates.find((t) => t.id === id) : undefined;
    setTemplateId(id);
    setErrors({}); setError(null);
    if (next) {
      const fresh = buildFormModel(next);
      // Keep what was typed for fields the new template shares, drop the rest.
      setRaws(Object.fromEntries(fresh.fields.map((f) => [f.key, raws[f.key] ?? ''])));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !template) return;
    setError(null);
    const checked = validateValues(model.fields, raws);
    const lErr = revise ? null : validateLabel(label);
    const nErr = validateNotes(notes);
    setErrors(checked.errors); setLabelError(lErr ?? undefined); setNotesError(nErr ?? undefined);
    if (!checked.ok || lErr || nErr) { setError('Please fix the highlighted fields.'); return; }
    if (props.mode === 'revise' && !revisionHasChange(props.set.values, checked.values, notes)) {
      setError('Nothing has changed since the last revision. Change a value or add a note explaining why you are recording it.');
      return;
    }
    setBusy(true);
    try {
      const trimmedNotes = notes.trim() || undefined;
      if (props.mode === 'revise') {
        const body: NewRevisionBody = { values: checked.values, notes: trimmedNotes };
        await api<MeasurementSet>(`/api/measurement-sets/${props.set.id}/revisions`, { method: 'POST', json: body });
        router.push(`/customers/${props.customerId}/measurements/${props.set.id}`);
      } else {
        const body: NewMeasurementSetBody = { templateId: template.id, label: label.trim(), values: checked.values, notes: trimmedNotes };
        const saved = await api<MeasurementSet>(`/api/customers/${props.customerId}/measurements`, { method: 'POST', json: body });
        router.push(`/customers/${props.customerId}/measurements/${saved.id}`);
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        // Zod reports value problems as "values.<key>"; show those next to the input as well as in the banner.
        const mapped: Record<string, string> = {};
        for (const [k, v] of Object.entries(err.fields)) if (k.startsWith('values.') && v[0]) mapped[k.slice(7)] = v[0];
        if (Object.keys(mapped).length) setErrors(mapped);
        if (err.fields.label?.[0]) setLabelError(err.fields.label[0]);
        if (err.fields.notes?.[0]) setNotesError(err.fields.notes[0]);
        if (err.code === 'label_exists') setLabelError('This customer already has a profile with that label.');
      }
      setError(messageFor(err)); // e.g. "Waist: must be at least 40." or "This template is inactive."
    } finally {
      setBusy(false);
    }
  }

  const cancelHref = revise ? `/customers/${props.customerId}/measurements/${props.set.id}` : `/customers/${props.customerId}`;

  return (
    <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy} noValidate>
      {error && <p role="alert" className="ap-alert">{error}</p>}

      {props.mode === 'new' ? (
        <>
          <SelectField id="m-template" label="Template" value={templateId} onChange={pickTemplate} options={props.templates.map((t) => ({ value: t.id, label: t.name }))} />
          {template?.description && <p className="ap-hint" style={{ margin: 0 }}>{template.description}</p>}
          <Field id="m-label" label="Profile label" required maxLength={LABEL_MAX} value={label} onChange={setLabel} error={labelError} hint="For example “Shirt, relaxed fit”. Must be unique for this customer." />
        </>
      ) : (
        <p className="ap-hint" style={{ margin: 0 }}>
          Template: <strong>{props.set.templateName}</strong>. A revision records a complete new set of values and does not patch the last one. Earlier revisions stay in the history.
        </p>
      )}

      {model.droppedKeys.length > 0 && (
        <p className="ap-alert" role="status">
          The template no longer has {model.droppedKeys.map((d) => `${d.label} (${d.value} ${d.unit})`).join(', ')}. {model.droppedKeys.length === 1 ? 'That value' : 'Those values'} will not carry over to the new revision.
        </p>
      )}

      {model.fields.length === 0 ? (
        <p className="ap-hint">This template has no fields yet.</p>
      ) : (
        <div className="ap-grid2">
          {model.fields.map((f) => (
            <Field
              key={`${template?.id}-${f.key}`}
              id={`m-${f.key}`}
              label={`${f.label} (${f.unit})${f.required ? ' *' : ''}`}
              inputMode="decimal"
              autoComplete="off"
              aria-required={f.required || undefined}
              value={raws[f.key] ?? ''}
              onChange={(v) => setRaws((r) => ({ ...r, [f.key]: v }))}
              error={errors[f.key]}
              hint={[f.required ? 'Required' : 'Optional', rangeHint(f)].filter(Boolean).join(' · ')}
            />
          ))}
        </div>
      )}

      <TextAreaField id="m-notes" label={revise ? 'Notes (why this revision?)' : 'Notes (optional)'} maxLength={NOTES_MAX} value={notes} onChange={setNotes} error={notesError} />

      <div className="ap-actions">
        <button className="ap-btn" type="submit" disabled={busy || !template || model.fields.length === 0}>{busy ? 'Saving…' : revise ? 'Save revision' : 'Save profile'}</button>
        <Link href={cancelHref} className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Cancel</Link>
      </div>
    </form>
  );
}
