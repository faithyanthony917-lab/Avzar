import { MEASUREMENT_UNITS, type MeasurementTemplate, type MeasurementUnit } from './measurement-types';
import { parseDecimal } from './measurement-view-model';

/**
 * Limits mirror templateSchema, fieldSchema and validateTemplateFields in backend-node/src/auth/customerRoutes.js.
 * The server stays the authority; this only gives quick feedback before the request.
 */
export const TEMPLATE_NAME_MIN = 2;
export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_DESCRIPTION_MAX = 500;
export const TEMPLATE_FIELDS_MAX = 60;
export const FIELD_LABEL_MAX = 60;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** One row of the editor. Keys of saved fields are locked: the key is what recorded values are stored under. */
export interface TemplateFormField {
  uid: string;
  /** Empty for a new row until it is saved; see resolveKeys. */
  key: string;
  label: string;
  unit: MeasurementUnit;
  min: string;
  max: string;
  required: boolean;
}

export interface TemplateFormInput { name: string; description: string; isActive: boolean; fields: TemplateFormField[] }

export interface TemplateFieldBody { key: string; label: string; unit: MeasurementUnit; minValue?: number; maxValue?: number; isRequired: boolean }
export interface TemplateBody { name: string; description?: string; isActive: boolean; fields: TemplateFieldBody[] }

export function blankField(uid: string): TemplateFormField {
  return { uid, key: '', label: '', unit: 'cm', min: '', max: '', required: false };
}

const numberText = (n: number | null) => (n === null ? '' : String(Math.round(n * 100) / 100));

export function fieldsFromTemplate(template: Pick<MeasurementTemplate, 'fields'>): TemplateFormField[] {
  return [...template.fields]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((f, i) => ({
      uid: `saved-${i}`, key: f.key, label: f.label, unit: f.unit, min: numberText(f.minValue), max: numberText(f.maxValue), required: f.isRequired,
    }));
}

/** "Chest / Bust" -> "chest_bust". Always matches the API's key pattern, or returns '' when nothing usable is left. */
export function keyFromLabel(label: string): string {
  const base = label
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) return '';
  const start = /^[a-z]/.test(base) ? base : `m_${base}`;
  return start.slice(0, 40).replace(/_+$/, '');
}

/** Gives every unsaved row a key from its label, unique among all rows. Saved keys never change. */
export function resolveKeys(fields: TemplateFormField[]): TemplateFormField[] {
  const taken = new Set(fields.filter((f) => f.key).map((f) => f.key));
  return fields.map((f, index) => {
    if (f.key) return f;
    const base = keyFromLabel(f.label) || `field_${index + 1}`;
    let key = base;
    for (let n = 2; taken.has(key); n += 1) {
      const suffix = `_${n}`;
      key = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    }
    taken.add(key);
    return { ...f, key };
  });
}

export interface FieldErrors { label?: string; min?: string; max?: string }
export interface TemplateErrors { name?: string; description?: string; fields?: string; byField: Record<string, FieldErrors> }
export type TemplateCheck = { ok: true; body: TemplateBody } | { ok: false; errors: TemplateErrors };

function optionalNumber(raw: string): { value?: number; error?: string } {
  if (!raw.trim()) return {};
  const parsed = parseDecimal(raw);
  if (!parsed.ok) return { error: parsed.error };
  if (parsed.value < 0) return { error: 'Cannot be negative.' };
  return { value: parsed.value };
}

export function validateTemplateForm(input: TemplateFormInput): TemplateCheck {
  const errors: TemplateErrors = { byField: {} };
  const name = input.name.trim();
  const description = input.description.trim();
  if (name.length < TEMPLATE_NAME_MIN) errors.name = `Give the template a name of at least ${TEMPLATE_NAME_MIN} characters.`;
  else if (name.length > TEMPLATE_NAME_MAX) errors.name = `Keep the name to ${TEMPLATE_NAME_MAX} characters or fewer.`;
  if (description.length > TEMPLATE_DESCRIPTION_MAX) errors.description = `Keep the description to ${TEMPLATE_DESCRIPTION_MAX} characters or fewer.`;
  if (input.fields.length === 0) errors.fields = 'Add at least one measurement.';
  else if (input.fields.length > TEMPLATE_FIELDS_MAX) errors.fields = `A template can have at most ${TEMPLATE_FIELDS_MAX} measurements.`;

  const fields = resolveKeys(input.fields);
  const body: TemplateFieldBody[] = [];
  const labelsSeen = new Map<string, string>();
  for (const f of fields) {
    const fe: FieldErrors = {};
    const label = f.label.trim();
    if (!label) fe.label = 'Enter a name for this measurement.';
    else if (label.length > FIELD_LABEL_MAX) fe.label = `Keep it to ${FIELD_LABEL_MAX} characters or fewer.`;
    else if (labelsSeen.has(label.toLowerCase())) fe.label = 'Another measurement already has this name.';
    else labelsSeen.set(label.toLowerCase(), f.uid);
    const min = optionalNumber(f.min);
    const max = optionalNumber(f.max);
    if (min.error) fe.min = min.error;
    if (max.error) fe.max = max.error;
    if (min.value !== undefined && max.value !== undefined && min.value > max.value) fe.min = 'Minimum is higher than the maximum.';
    if (!KEY_PATTERN.test(f.key)) fe.label ??= 'Use letters or numbers in the name.';
    if (!MEASUREMENT_UNITS.includes(f.unit)) fe.label ??= 'Pick a unit.';
    if (fe.label || fe.min || fe.max) errors.byField[f.uid] = fe;
    body.push({ key: f.key, label, unit: f.unit, minValue: min.value, maxValue: max.value, isRequired: f.required });
  }

  if (errors.name || errors.description || errors.fields || Object.keys(errors.byField).length) return { ok: false, errors };
  return { ok: true, body: { name, description: description || undefined, isActive: input.isActive, fields: body } };
}

/** Moves a row up (-1) or down (+1). Out-of-range moves return the list unchanged. */
export function moveField<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function fieldCountText(count: number): string {
  return `${count} measurement${count === 1 ? '' : 's'}`;
}
