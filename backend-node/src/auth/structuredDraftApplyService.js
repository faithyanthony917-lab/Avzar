import { AppError } from '../http/errors.js';
import { getCollection, updateCollection } from './collectionService.js';
import { getDesign, updateDesign } from './designService.js';

/** Applies only the two structured draft types mapped to existing catalog records. The update
 * services perform tenant-scoped writes, optimistic concurrency checks and audit logging. */
export async function applyStructuredTextDraft(pool, user, payload, deps = {}) {
  const readDesign = deps.getDesign ?? getDesign;
  const writeDesign = deps.updateDesign ?? updateDesign;
  const readCollection = deps.getCollection ?? getCollection;
  const writeCollection = deps.updateCollection ?? updateCollection;
  if (payload.type === 'product_description') {
    const current = await readDesign(pool, user.businessId, payload.targetId);
    if (current.version !== payload.version) throw AppError.conflict('stale_version', 'The design changed since you reviewed this draft. Reload it before applying.');
    const item = await writeDesign(pool, user, payload.targetId, {
      name: current.name, description: payload.description, kind: current.kind, categoryId: current.categoryId,
      garmentType: current.garmentType, tags: current.tags ?? [], fabrics: current.fabrics ?? [], colours: current.colours ?? [],
      sizes: current.sizes ?? [], basePrice: current.basePrice == null ? null : Number(current.basePrice),
      productionDays: current.productionDays, isFeatured: current.isFeatured, parentDesignId: current.parentDesignId, version: payload.version,
    });
    return { applied: true, type: payload.type, item };
  }
  if (payload.type === 'collection_names') {
    const current = await readCollection(pool, user.businessId, payload.targetId);
    if (current.version !== payload.version) throw AppError.conflict('stale_version', 'The collection changed since you reviewed this draft. Reload it before applying.');
    const item = await writeCollection(pool, user, payload.targetId, {
      name: payload.name, description: current.description, visibility: current.visibility, sortOrder: current.sortOrder, version: payload.version,
    });
    return { applied: true, type: payload.type, item };
  }
  throw AppError.badRequest('draft_type_not_applicable', 'Only product descriptions and collection names can be applied to catalog records.');
}
