import { describe, expect, it } from 'vitest';
import { bulkCatalogPayload } from '../design-catalog';

const ids = ['design-a', 'design-b'];

describe('catalog bulk action payloads', () => {
  it('maps archive and activate to the status API contract', () => {
    expect(bulkCatalogPayload(ids, 'archive')).toEqual({ ids, action: 'status', status: 'Archived' });
    expect(bulkCatalogPayload(ids, 'activate')).toEqual({ ids, action: 'status', status: 'Active' });
  });

  it('maps public and private actions to the visibility API contract', () => {
    expect(bulkCatalogPayload(ids, 'make-public')).toEqual({ ids, action: 'visibility', visibility: 'Public' });
    expect(bulkCatalogPayload(ids, 'make-private')).toEqual({ ids, action: 'visibility', visibility: 'Private' });
  });

  it('maps featured toggles to the featured API contract', () => {
    expect(bulkCatalogPayload(ids, 'feature')).toEqual({ ids, action: 'featured', isFeatured: true });
    expect(bulkCatalogPayload(ids, 'unfeature')).toEqual({ ids, action: 'featured', isFeatured: false });
  });
});
