export type CatalogBulkAction = 'archive' | 'activate' | 'make-public' | 'make-private' | 'feature' | 'unfeature';
export type CatalogBulkPayload =
  | { ids: string[]; action: 'status'; status: 'Active' | 'Archived' }
  | { ids: string[]; action: 'visibility'; visibility: 'Private' | 'Public' }
  | { ids: string[]; action: 'featured'; isFeatured: boolean };

export function bulkCatalogPayload(ids: string[], action: CatalogBulkAction): CatalogBulkPayload {
  if (action === 'archive') return { ids, action: 'status', status: 'Archived' };
  if (action === 'activate') return { ids, action: 'status', status: 'Active' };
  if (action === 'make-public') return { ids, action: 'visibility', visibility: 'Public' };
  if (action === 'make-private') return { ids, action: 'visibility', visibility: 'Private' };
  return { ids, action: 'featured', isFeatured: action === 'feature' };
}
