// Pure helpers for the task material panel. No imports: unit-tested in test/task-materials.test.ts.
// Limits mirror taskMaterialsSchema (backend-node/src/auth/catalogRoutes.js:66-69): 1-100 materials, each quantity positive,
// at most 3 decimals, at most 1,000,000,000; note at most 500 characters.

export const MAX_MATERIALS = 100;
export const NOTE_MAX = 500;
export const QUANTITY_MAX = 1_000_000_000;

export type TaskMaterialAction = 'reserve' | 'release' | 'consume';

/** One row of GET /api/inventory (inventoryService.js materialDto). */
export interface StockMaterial { id: string; locationId: string | null; sku: string; name: string; unit: string; onHand: number; reserved: number; available: number; reorderLevel: number; lowStock: boolean; version: number }

export interface SelectedRow { materialId: string; label: string; quantity: string }
export type TaskMaterialsBody = { materials: { materialId: string; quantity: number }[]; note: string | null };

/** Parses what a person typed. Works on the text, not the float, so "0.0005" and "1e3" are refused instead of being rounded or expanded. */
export function parseQuantity(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return null;
  const n = Number(text);
  if (!(n > 0) || n > QUANTITY_MAX) return null;
  return /^\d+(?:\.\d{1,3})?$/.test(String(n)) ? n : null; // the API re-checks String(value); keep both sides identical
}

export function buildTaskMaterialsPayload(rows: SelectedRow[], note: string): { ok: true; body: TaskMaterialsBody } | { ok: false; error: string } {
  if (rows.length === 0) return { ok: false, error: 'Tick at least one material.' };
  if (rows.length > MAX_MATERIALS) return { ok: false, error: `Choose at most ${MAX_MATERIALS} materials at a time.` };
  if (new Set(rows.map((r) => r.materialId)).size !== rows.length) return { ok: false, error: 'Each material can be listed only once.' };
  const materials: TaskMaterialsBody['materials'] = [];
  for (const r of rows) {
    const quantity = parseQuantity(r.quantity);
    if (quantity === null) return { ok: false, error: `Enter a quantity above 0 for ${r.label}, with at most 3 decimals and no more than 1,000,000,000.` };
    materials.push({ materialId: r.materialId, quantity });
  }
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) return { ok: false, error: `The note can be at most ${NOTE_MAX} characters.` };
  return { ok: true, body: { materials, note: trimmed || null } };
}

export function confirmMessage(action: 'reserve' | 'consume', count: number): string {
  const things = `${count} material${count === 1 ? '' : 's'}`;
  return action === 'reserve'
    ? `Reserve ${things} for this task? The quantities will no longer be available to other tasks.`
    : `Consume ${things} for this task? Stock on hand will go down and this cannot be undone.`;
}

/** The panel is offered while the task can still use stock (the API refuses Completed and Cancelled: inventoryService.js taskAndOrder). */
export function canManageTaskMaterials(status: string, canManage: boolean, canView: boolean): boolean {
  return canManage && canView && status !== 'Completed' && status !== 'Cancelled';
}
