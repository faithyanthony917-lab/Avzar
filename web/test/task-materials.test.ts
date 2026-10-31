import { describe, expect, it } from 'vitest';
import { buildTaskMaterialsPayload, canManageTaskMaterials, confirmMessage, parseQuantity } from '../src/lib/task-materials';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, quantity = '1') => ({ materialId: id(n), label: `Cloth ${n}`, quantity });

describe('parseQuantity (taskMaterialsSchema: positive, max 3 decimals, max 1e9)', () => {
  it.each([['1', 1], ['0.5', 0.5], [' 2.25 ', 2.25], ['0.001', 0.001], ['1000000000', 1_000_000_000], ['12.340', 12.34]])('accepts %j', (raw, want) => expect(parseQuantity(raw)).toBe(want));
  it.each([[''], ['0'], ['0.000'], ['-1'], ['1.2345'], ['0.0005'], ['1e3'], ['1,5'], ['abc'], ['1000000000.001'], ['1000000001'], ['.5'], ['5.']])('rejects %j', (raw) => expect(parseQuantity(raw)).toBeNull());
});

describe('buildTaskMaterialsPayload', () => {
  it('needs at least one material', () => expect(buildTaskMaterialsPayload([], '')).toMatchObject({ ok: false }));
  it('allows at most 100 materials', () => {
    const many = Array.from({ length: 101 }, (_, i) => row(i + 1));
    expect(buildTaskMaterialsPayload(many, '')).toMatchObject({ ok: false });
    expect(buildTaskMaterialsPayload(many.slice(0, 100), '')).toMatchObject({ ok: true });
  });
  it('refuses a repeated material (the API refuses it too)', () => expect(buildTaskMaterialsPayload([row(1), row(1)], '')).toMatchObject({ ok: false }));
  it('names the material with a bad quantity', () => {
    const r = buildTaskMaterialsPayload([row(1), row(2, '0')], '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Cloth 2/);
  });
  it('builds numbers and a null note when the note is blank', () => expect(buildTaskMaterialsPayload([row(1, '2.5')], '   ')).toEqual({ ok: true, body: { materials: [{ materialId: id(1), quantity: 2.5 }], note: null } }));
  it('trims the note', () => expect(buildTaskMaterialsPayload([row(1)], '  for the lining ')).toEqual({ ok: true, body: { materials: [{ materialId: id(1), quantity: 1 }], note: 'for the lining' } }));
  it('allows a 500 character note and refuses 501', () => {
    expect(buildTaskMaterialsPayload([row(1)], 'x'.repeat(500))).toMatchObject({ ok: true });
    expect(buildTaskMaterialsPayload([row(1)], 'x'.repeat(501))).toMatchObject({ ok: false });
  });
});

describe('confirmMessage', () => {
  it('pluralises', () => {
    expect(confirmMessage('reserve', 1)).toMatch(/Reserve 1 material for/);
    expect(confirmMessage('consume', 3)).toMatch(/Consume 3 materials for/);
  });
});

describe('canManageTaskMaterials', () => {
  it('needs both permissions', () => {
    expect(canManageTaskMaterials('InProgress', true, true)).toBe(true);
    expect(canManageTaskMaterials('InProgress', true, false)).toBe(false);
    expect(canManageTaskMaterials('InProgress', false, true)).toBe(false);
  });
  it('is hidden once the task is closed', () => {
    expect(canManageTaskMaterials('Completed', true, true)).toBe(false);
    expect(canManageTaskMaterials('Cancelled', true, true)).toBe(false);
    expect(canManageTaskMaterials('Blocked', true, true)).toBe(true);
  });
});
