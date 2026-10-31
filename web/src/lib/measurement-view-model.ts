import type {
  MeasurementDiffRow, MeasurementTemplate, MeasurementTemplateField, MeasurementUnit, MeasurementValue,
} from './measurement-types';

/** Same limits as the API: label 1-80 (customerRoutes.js:44-45) and notes <= 2000. */
export const LABEL_MAX = 80;
export const NOTES_MAX = 2000;
/** The API allows at most two decimal places (validateMeasurementValues, customerRoutes.js:195). */
export const MAX_DECIMALS = 2;
/** Beyond this, value * 100 stops being exact in floating point, so the API's own rounding check would misfire. */
export const MAX_ABS_VALUE = 1_000_000_000_000;

// ---------------------------------------------------------------- parsing

export type ParsedNumber = { ok: true; value: number } | { ok: false; error: string };

/**
 * Decimal-safe parsing of what a person typed. A single "." or "," is the decimal mark.
 * Input holding both marks ("1,234.5") is refused because thousands separators are ambiguous.
 * More than two decimals is refused, never silently rounded. Blank input is the caller's concern.
 */
export function parseDecimal(raw: string): ParsedNumber {
  const text = raw.trim();
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(text)) {
    return { ok: false, error: /[.,].*[.,]/.test(text) ? 'Use a single decimal mark and no thousands separators.' : 'Enter a number, for example 42.5.' };
  }
  const normalised = text.replace(',', '.');
  const [whole = '', frac = ''] = normalised.replace(/^[+-]/, '').split('.');
  if (frac.replace(/0+$/, '').length > MAX_DECIMALS) return { ok: false, error: `Use at most ${MAX_DECIMALS} decimal places.` };
  const value = Number(normalised);
  if (!Number.isFinite(value) || Math.abs(value) >= MAX_ABS_VALUE || whole.length > 13) return { ok: false, error: 'That number is too large.' };
  return { ok: true, value: value === 0 ? 0 : value }; // normalises -0
}

/** The text shown in an input for a stored number. Always a dot, never exponent form. */
export function numberToInput(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------- form model

export interface FormField {
  key: string;
  label: string;
  unit: MeasurementUnit;
  min: number | null;
  max: number | null;
  required: boolean;
  /** What the input shows. */
  raw: string;
}

export interface FormModel {
  fields: FormField[];
  /** Previously recorded keys the template no longer has. The API refuses unknown keys, so they cannot be carried over. */
  droppedKeys: { key: string; label: string; value: number; unit: MeasurementUnit }[];
}

/** One input per template field in sortOrder, optionally pre-filled from earlier values. */
export function buildFormModel(template: Pick<MeasurementTemplate, 'fields'>, existing: MeasurementValue[] = []): FormModel {
  const byKey = new Map(existing.map((v) => [v.key, v]));
  const sorted = [...template.fields].sort((a, b) => a.sortOrder - b.sortOrder);
  const fields = sorted.map((f: MeasurementTemplateField): FormField => {
    const prev = byKey.get(f.key);
    return {
      key: f.key, label: f.label, unit: f.unit, min: f.minValue, max: f.maxValue, required: f.isRequired,
      raw: prev ? numberToInput(prev.value) : '',
    };
  });
  const known = new Set(fields.map((f) => f.key));
  const droppedKeys = existing.filter((v) => !known.has(v.key)).map(({ key, label, value, unit }) => ({ key, label, value, unit }));
  return { fields, droppedKeys };
}

export function rangeHint(f: Pick<FormField, 'min' | 'max' | 'unit'>): string | undefined {
  if (f.min !== null && f.max !== null) return `${f.min}–${f.max} ${f.unit}`;
  if (f.min !== null) return `At least ${f.min} ${f.unit}`;
  if (f.max !== null) return `At most ${f.max} ${f.unit}`;
  return undefined;
}

// ---------------------------------------------------------------- validation

export interface ValidationResult {
  values: Record<string, number>;
  /** Field key -> message. A key not in the template appears under its own name. */
  errors: Record<string, string>;
  ok: boolean;
}

/**
 * The client-side twin of validateMeasurementValues (customerRoutes.js:187-209): required fields,
 * numeric format, two decimals, min and max. Fields the template does not know are never sent.
 */
export function validateValues(fields: FormField[], raws: Record<string, string>): ValidationResult {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(raws)) {
    if (!known.has(key) && raws[key]!.trim() !== '') errors[key] = 'This measurement is not part of the template.';
  }
  for (const f of fields) {
    const raw = (raws[f.key] ?? '').trim();
    if (raw === '') {
      if (f.required) errors[f.key] = `${f.label} is required.`;
      continue;
    }
    const parsed = parseDecimal(raw);
    if (!parsed.ok) { errors[f.key] = parsed.error; continue; }
    if (f.min !== null && parsed.value < f.min) { errors[f.key] = `Must be at least ${f.min}.`; continue; }
    if (f.max !== null && parsed.value > f.max) { errors[f.key] = `Must be at most ${f.max}.`; continue; }
    values[f.key] = parsed.value;
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

export function validateLabel(label: string): string | null {
  const t = label.trim();
  if (!t) return 'Give the profile a label.';
  if (t.length > LABEL_MAX) return `Keep the label to ${LABEL_MAX} characters.`;
  return null;
}

export function validateNotes(notes: string): string | null {
  return notes.trim().length > NOTES_MAX ? `Keep notes to ${NOTES_MAX} characters.` : null;
}

/**
 * Whether a revision differs from the last one in values or carries a note. The API accepts an identical
 * revision with no note, so this is a UI-side guard against accidental duplicates, not a server rule.
 */
export function revisionHasChange(previous: MeasurementValue[], next: Record<string, number>, notes: string): boolean {
  if (notes.trim()) return true;
  const prev = new Map(previous.map((v) => [v.key, v.value]));
  const nextKeys = Object.keys(next);
  if (nextKeys.length !== prev.size) return true;
  return nextKeys.some((k) => prev.get(k) !== next[k]);
}

// ---------------------------------------------------------------- display

export function formatValue(value: number | null, unit: string): string {
  return value === null ? '—' : `${numberToInput(value)} ${unit}`;
}

/**
 * A signed change, rounded to two places because the API computes delta in floating point
 * (0.3 - 0.1 arrives as 0.19999999999999998). Zero has no sign; null means a field is on one side only.
 */
export function formatDelta(delta: number | null, unit: string): string {
  if (delta === null) return '—';
  const rounded = Math.round(delta * 100) / 100;
  if (rounded === 0) return `0 ${unit}`;
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} ${unit}`;
}

export type DiffKind = 'changed' | 'unchanged' | 'added' | 'removed';
export function diffKind(row: Pick<MeasurementDiffRow, 'from' | 'to' | 'delta'>): DiffKind {
  if (row.from === null && row.to !== null) return 'added';
  if (row.from !== null && row.to === null) return 'removed';
  return row.delta !== null && Math.round(row.delta * 100) === 0 ? 'unchanged' : 'changed';
}

// ---------------------------------------------------------------- compare selection

export interface CompareSelection { from: number; to: number }

/** The API requires positive integers (customerRoutes.js:760-764). Returns null for anything else. */
export function parseRevisionNumber(raw: string | string[] | undefined): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (s === undefined || !/^[1-9]\d{0,8}$/.test(s)) return null;
  return Number(s);
}

/**
 * Picks the two revisions to compare from the URL, falling back to previous vs latest.
 * The API does not reject from == to, but a comparison of a revision with itself is meaningless, so that is refused here.
 * Returns null when fewer than two revisions exist.
 */
export function resolveCompare(available: number[], fromRaw: string | string[] | undefined, toRaw: string | string[] | undefined): CompareSelection | null {
  const nums = [...new Set(available.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (nums.length < 2) return null;
  const from = parseRevisionNumber(fromRaw);
  const to = parseRevisionNumber(toRaw);
  if (from !== null && to !== null && from !== to && nums.includes(from) && nums.includes(to)) return { from, to };
  return { from: nums[nums.length - 2]!, to: nums[nums.length - 1]! };
}


/** Measurements older than 90 days should be rechecked before a new garment is cut. Invalid dates do not trigger a warning. */
export function isMeasurementStale(updatedAtUtc: string, now: Date | number = Date.now(), staleAfterDays = 90): boolean {
  const updated = new Date(updatedAtUtc).getTime();
  const current = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(updated) || !Number.isFinite(current) || !Number.isFinite(staleAfterDays) || staleAfterDays < 0) return false;
  return current >= updated && current - updated >= staleAfterDays * 24 * 60 * 60 * 1000;
}
