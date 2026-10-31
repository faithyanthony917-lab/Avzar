export type ProductDescriptionApply = { type: 'product_description'; targetId: string; version: number; description: string };
export type CollectionNameApply = { type: 'collection_names'; targetId: string; version: number; name: string };
export type StructuredDraftApply = ProductDescriptionApply | CollectionNameApply;

export function productDescriptionApply(targetId: string, version: number, draft: unknown): ProductDescriptionApply {
  const description = typeof draft === 'string' ? draft.trim() : '';
  if (!targetId || !Number.isSafeInteger(version) || version < 0 || !description || description.length > 2500) {
    throw new Error('Choose a design and a valid product description before applying.');
  }
  return { type: 'product_description', targetId, version, description };
}

export function collectionNameApply(targetId: string, version: number, name: string): CollectionNameApply {
  const cleanName = name.trim();
  if (!targetId || !Number.isSafeInteger(version) || version < 0 || cleanName.length < 2 || cleanName.length > 120) {
    throw new Error('Choose a collection and a valid suggested name before applying.');
  }
  return { type: 'collection_names', targetId, version, name: cleanName };
}
