import { describe, expect, it } from 'vitest';
import {
  buildFormModel, diffKind, formatDelta, formatValue, isMeasurementStale, numberToInput, parseDecimal, parseRevisionNumber, rangeHint,
  resolveCompare, revisionHasChange, validateLabel, validateNotes, validateValues,
} from '../measurement-view-model';
import type { MeasurementTemplate, MeasurementValue } from '../measurement-types';

const template: Pick<MeasurementTemplate, 'fields'> = {
  fields: [
    { key: 'waist', label: 'Waist', unit: 'cm', minValue: 40, maxValue: 200, isRequired: true, sortOrder: 1 },
    { key: 'chest', label: 'Chest', unit: 'cm', minValue: null, maxValue: null, isRequired: true, sortOrder: 0 },
    { key: 'weight', label: 'Weight', unit: 'kg', minValue: null, maxValue: 300, isRequired: false, sortOrder: 2 },
  ],
};
const val = (key: string, value: number, label = key): MeasurementValue => ({ key, label, unit: 'cm', value });

describe('parseDecimal', () => {
  it.each([['42', 42], ['42.5', 42.5], ['42,5', 42.5], [' 7 ', 7], ['.5', 0.5], ['5.', 5], ['1.50', 1.5], ['0', 0], ['-0', 0], ['+3', 3]])('accepts %j', (raw, expected) => {
    expect(parseDecimal(raw)).toEqual({ ok: true, value: expected });
  });
  it.each([['abc'], ['1e3'], ['--1'], ['1,234.5'], ['1.234,5'], ['1.2.3'], ['1 2'], ['NaN'], ['Infinity'], ['']])('refuses %j', (raw) => {
    expect(parseDecimal(raw).ok).toBe(false);
  });
  it('says why a mixed separator is refused', () => {
    expect(parseDecimal('1,234.5')).toEqual({ ok: false, error: 'Use a single decimal mark and no thousands separators.' });
  });
  it('refuses more than two decimals instead of rounding, but allows trailing zeros', () => {
    expect(parseDecimal('1.005').ok).toBe(false);
    expect(parseDecimal('1,005').ok).toBe(false);
    expect(parseDecimal('1.500')).toEqual({ ok: true, value: 1.5 });
  });
  it('refuses numbers too large to check exactly', () => {
    expect(parseDecimal('1000000000000').ok).toBe(false);
    expect(parseDecimal('9'.repeat(400)).ok).toBe(false);
  });
  it('keeps 0.1 + 0.2 style input exact', () => {
    expect(parseDecimal('0.29')).toEqual({ ok: true, value: 0.29 });
    const v = (parseDecimal('1.15') as { value: number }).value;
    expect(Math.round(v * 100) / 100).toBe(v); // passes the API's own two-decimal check
  });
});

describe('buildFormModel', () => {
  it('orders fields by sortOrder and carries rules over', () => {
    const m = buildFormModel(template);
    expect(m.fields.map((f) => f.key)).toEqual(['chest', 'waist', 'weight']);
    expect(m.fields[1]).toMatchObject({ min: 40, max: 200, required: true, unit: 'cm', raw: '' });
    expect(m.droppedKeys).toEqual([]);
  });
  it('pre-fills from earlier values with a dot decimal', () => {
    const m = buildFormModel(template, [val('chest', 96.5), val('waist', 82)]);
    expect(m.fields.map((f) => f.raw)).toEqual(['96.5', '82', '']);
  });
  it('reports earlier values whose field left the template, and does not pre-fill them', () => {
    const m = buildFormModel(template, [val('chest', 96), val('sleeve', 61, 'Sleeve')]);
    expect(m.fields.map((f) => f.key)).not.toContain('sleeve');
    expect(m.droppedKeys).toEqual([{ key: 'sleeve', label: 'Sleeve', value: 61, unit: 'cm' }]);
  });
  it('does not mutate the template', () => {
    const copy = JSON.stringify(template);
    buildFormModel(template);
    expect(JSON.stringify(template)).toBe(copy);
  });
});

describe('validateValues', () => {
  const { fields } = buildFormModel(template);
  it('accepts a complete, in-range set with comma decimals and skips blank optional fields', () => {
    const r = validateValues(fields, { chest: '96,5', waist: '82', weight: '' });
    expect(r).toEqual({ values: { chest: 96.5, waist: 82 }, errors: {}, ok: true });
  });
  it('requires required fields, including whitespace-only', () => {
    const r = validateValues(fields, { chest: '  ', waist: '' });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual({ chest: 'Chest is required.', waist: 'Waist is required.' });
  });
  it('enforces min and max, inclusive', () => {
    expect(validateValues(fields, { chest: '90', waist: '39.99' }).errors.waist).toBe('Must be at least 40.');
    expect(validateValues(fields, { chest: '90', waist: '200.01' }).errors.waist).toBe('Must be at most 200.');
    expect(validateValues(fields, { chest: '90', waist: '40' }).ok).toBe(true);
    expect(validateValues(fields, { chest: '90', waist: '200' }).ok).toBe(true);
  });
  it('reports bad numbers per field and keeps good ones out of errors', () => {
    const r = validateValues(fields, { chest: 'abc', waist: '82', weight: '70.123' });
    expect(Object.keys(r.errors).sort()).toEqual(['chest', 'weight']);
    expect(r.values).toEqual({ waist: 82 });
  });
  it('never sends keys the template does not have, and flags them', () => {
    const r = validateValues(fields, { chest: '90', waist: '82', sleeve: '61' });
    expect(r.ok).toBe(false);
    expect(r.errors.sleeve).toMatch(/not part of the template/);
    expect(r.values).not.toHaveProperty('sleeve');
  });
  it('ignores a blank unknown key', () => {
    expect(validateValues(fields, { chest: '90', waist: '82', sleeve: '' }).ok).toBe(true);
  });
  it('accepts a template with no required fields and no values', () => {
    expect(validateValues([], {})).toEqual({ values: {}, errors: {}, ok: true });
  });
});

describe('label and notes', () => {
  it('requires a label of at most 80 characters', () => {
    expect(validateLabel('  ')).not.toBeNull();
    expect(validateLabel('a'.repeat(80))).toBeNull();
    expect(validateLabel('a'.repeat(81))).not.toBeNull();
  });
  it('limits notes to 2000 characters', () => {
    expect(validateNotes('a'.repeat(2000))).toBeNull();
    expect(validateNotes('a'.repeat(2001))).not.toBeNull();
  });
});

describe('revisionHasChange', () => {
  const prev = [val('chest', 96), val('waist', 82)];
  it('is false for identical values and no note', () => expect(revisionHasChange(prev, { chest: 96, waist: 82 }, '  ')).toBe(false));
  it('is true for a changed value', () => expect(revisionHasChange(prev, { chest: 97, waist: 82 }, '')).toBe(true));
  it('is true for a note alone', () => expect(revisionHasChange(prev, { chest: 96, waist: 82 }, 'Posture change')).toBe(true));
  it('is true when a field is added or cleared', () => {
    expect(revisionHasChange(prev, { chest: 96, waist: 82, weight: 70 }, '')).toBe(true);
    expect(revisionHasChange(prev, { chest: 96 }, '')).toBe(true);
  });
});

describe('formatting', () => {
  it('formats values with units and a dash for none', () => {
    expect(formatValue(96.5, 'cm')).toBe('96.5 cm');
    expect(formatValue(82, 'cm')).toBe('82 cm');
    expect(formatValue(null, 'cm')).toBe('—');
    expect(numberToInput(0.30000000000000004)).toBe('0.3');
  });
  it('signs deltas and uses a real minus', () => {
    expect(formatDelta(1.5, 'cm')).toBe('+1.5 cm');
    expect(formatDelta(-2, 'cm')).toBe('−2 cm');
  });
  it('rounds floating point noise from the API', () => {
    expect(formatDelta(0.30000000000000004, 'cm')).toBe('+0.3 cm');
    expect(formatDelta(-0.19999999999999998, 'in')).toBe('−0.2 in');
    expect(formatDelta(0.004, 'cm')).toBe('0 cm');
    expect(formatDelta(-0.004, 'cm')).toBe('0 cm');
  });
  it('shows no change and no delta distinctly', () => {
    expect(formatDelta(0, 'cm')).toBe('0 cm');
    expect(formatDelta(null, 'cm')).toBe('—');
  });
  it('describes a range', () => {
    expect(rangeHint({ min: 40, max: 200, unit: 'cm' })).toBe('40–200 cm');
    expect(rangeHint({ min: 40, max: null, unit: 'cm' })).toBe('At least 40 cm');
    expect(rangeHint({ min: null, max: 300, unit: 'kg' })).toBe('At most 300 kg');
    expect(rangeHint({ min: null, max: null, unit: 'kg' })).toBeUndefined();
  });
});

describe('diffKind (fields added or removed between revisions)', () => {
  it('detects added, removed, changed and unchanged', () => {
    expect(diffKind({ from: null, to: 5, delta: null })).toBe('added');
    expect(diffKind({ from: 5, to: null, delta: null })).toBe('removed');
    expect(diffKind({ from: 5, to: 6, delta: 1 })).toBe('changed');
    expect(diffKind({ from: 5, to: 5, delta: 0 })).toBe('unchanged');
    expect(diffKind({ from: 0.1, to: 0.1, delta: 0.0000001 })).toBe('unchanged');
  });
});

describe('compare selection', () => {
  it('accepts only positive integers', () => {
    expect(parseRevisionNumber('3')).toBe(3);
    expect(parseRevisionNumber(['2', '9'])).toBe(2);
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1abc', '01', undefined]) expect(parseRevisionNumber(bad)).toBeNull();
  });
  it('needs two revisions', () => {
    expect(resolveCompare([1], '1', '2')).toBeNull();
    expect(resolveCompare([], undefined, undefined)).toBeNull();
  });
  it('defaults to previous vs latest', () => {
    expect(resolveCompare([3, 1, 2], undefined, undefined)).toEqual({ from: 2, to: 3 });
  });
  it('keeps a valid pair, in either order', () => {
    expect(resolveCompare([1, 2, 3], '1', '3')).toEqual({ from: 1, to: 3 });
    expect(resolveCompare([1, 2, 3], '3', '1')).toEqual({ from: 3, to: 1 });
  });
  it('guards from == to, unknown revisions and junk', () => {
    expect(resolveCompare([1, 2, 3], '2', '2')).toEqual({ from: 2, to: 3 });
    expect(resolveCompare([1, 2, 3], '1', '9')).toEqual({ from: 2, to: 3 });
    expect(resolveCompare([1, 2, 3], 'x', '1')).toEqual({ from: 2, to: 3 });
  });
});


describe('isMeasurementStale', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  it('warns at 90 days and later, but not just before the threshold', () => {
    expect(isMeasurementStale('2026-07-21T12:00:00.000Z', now)).toBe(true);
    expect(isMeasurementStale('2026-07-21T12:00:00.001Z', now)).toBe(false);
  });
  it('does not warn for future, invalid, or under-threshold dates', () => {
    expect(isMeasurementStale('2026-10-01T00:00:00.000Z', now)).toBe(false);
    expect(isMeasurementStale('not-a-date', now)).toBe(false);
    expect(isMeasurementStale('2026-10-19T12:00:00.000Z', now)).toBe(false);
  });
});
