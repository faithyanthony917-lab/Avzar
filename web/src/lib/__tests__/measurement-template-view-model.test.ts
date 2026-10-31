import { describe, expect, it } from 'vitest';
import {
  blankField, fieldCountText, fieldsFromTemplate, keyFromLabel, moveField, resolveKeys, validateTemplateForm,
  type TemplateFormField, type TemplateFormInput,
} from '../measurement-template-view-model';

const field = (over: Partial<TemplateFormField> = {}): TemplateFormField => ({ ...blankField('f1'), label: 'Chest', ...over });
const form = (over: Partial<TemplateFormInput> = {}): TemplateFormInput => ({ name: 'Shirt', description: '', isActive: true, fields: [field()], ...over });

describe('keyFromLabel', () => {
  it('makes keys the API accepts', () => {
    expect(keyFromLabel('Chest / Bust')).toBe('chest_bust');
    expect(keyFromLabel('  Waist (natural) ')).toBe('waist_natural');
    expect(keyFromLabel('Épaule')).toBe('epaule');
    expect(keyFromLabel('3/4 sleeve')).toBe('m_3_4_sleeve');
  });
  it('caps the length at 40 and returns blank when nothing usable is left', () => {
    expect(keyFromLabel('a'.repeat(60))).toHaveLength(40);
    expect(keyFromLabel('胸围')).toBe('');
    expect(keyFromLabel('---')).toBe('');
  });
});

describe('resolveKeys', () => {
  it('keeps saved keys and makes new keys unique', () => {
    const rows = resolveKeys([field({ uid: 'a', key: 'chest', label: 'Chest size' }), field({ uid: 'b', label: 'Chest' }), field({ uid: 'c', label: 'Chest' })]);
    expect(rows.map((r) => r.key)).toEqual(['chest', 'chest_2', 'chest_3']);
  });
  it('falls back to a numbered key for labels with no usable letters', () => {
    expect(resolveKeys([field({ label: '胸围' })])[0]!.key).toBe('field_1');
  });
});

describe('validateTemplateForm', () => {
  it('builds the API body, trimming text and dropping blank optional values', () => {
    const check = validateTemplateForm(form({ name: '  Shirt ', description: ' ', fields: [field({ label: ' Chest ', min: '80', max: '140,5', required: true })] }));
    expect(check).toEqual({
      ok: true,
      body: { name: 'Shirt', description: undefined, isActive: true, fields: [{ key: 'chest', label: 'Chest', unit: 'cm', minValue: 80, maxValue: 140.5, isRequired: true }] },
    });
  });
  it('asks for a name and at least one measurement', () => {
    const check = validateTemplateForm(form({ name: 'A', fields: [] }));
    expect(check.ok).toBe(false);
    if (!check.ok) { expect(check.errors.name).toBeTruthy(); expect(check.errors.fields).toBeTruthy(); }
  });
  it('flags a blank or repeated measurement name on the right row', () => {
    const check = validateTemplateForm(form({ fields: [field({ uid: 'a' }), field({ uid: 'b', label: ' chest ' }), field({ uid: 'c', label: '' })] }));
    expect(check.ok).toBe(false);
    if (!check.ok) { expect(check.errors.byField.a).toBeUndefined(); expect(check.errors.byField.b?.label).toBeTruthy(); expect(check.errors.byField.c?.label).toBeTruthy(); }
  });
  it('rejects negative, malformed and reversed ranges', () => {
    const check = validateTemplateForm(form({ fields: [field({ uid: 'a', min: '-1' }), field({ uid: 'b', label: 'Waist', min: 'abc' }), field({ uid: 'c', label: 'Hip', min: '90', max: '80' })] }));
    expect(check.ok).toBe(false);
    if (!check.ok) { expect(check.errors.byField.a?.min).toBeTruthy(); expect(check.errors.byField.b?.min).toBeTruthy(); expect(check.errors.byField.c?.min).toMatch(/higher/); }
  });
  it('allows a template with all measurements optional and no range', () => {
    expect(validateTemplateForm(form({ isActive: false })).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('loads saved fields in sort order with numbers as text and saved keys', () => {
    const rows = fieldsFromTemplate({ fields: [
      { key: 'waist', label: 'Waist', unit: 'cm', minValue: null, maxValue: 120.5, isRequired: false, sortOrder: 1 },
      { key: 'chest', label: 'Chest', unit: 'in', minValue: 30, maxValue: null, isRequired: true, sortOrder: 0 },
    ] });
    expect(rows.map((r) => r.key)).toEqual(['chest', 'waist']);
    expect(rows[0]).toMatchObject({ unit: 'in', min: '30', max: '', required: true });
    expect(rows[1]).toMatchObject({ min: '', max: '120.5' });
  });
  it('moves rows within bounds only', () => {
    expect(moveField(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveField(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveField(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });
  it('pluralises the count', () => {
    expect(fieldCountText(1)).toBe('1 measurement');
    expect(fieldCountText(8)).toBe('8 measurements');
  });
});
