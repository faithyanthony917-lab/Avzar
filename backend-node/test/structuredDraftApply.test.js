import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructuredTextDraft } from '../src/auth/structuredDraftApplyService.js';

const user = { businessId: 'tenant-a', userId: 'user-a' };
const target = '00000000-0000-4000-8000-000000000001';

test('product-description apply previews a versioned catalog design and uses the validated update service', async () => {
  let updated;
  const current = { id: target, name: 'Kaftan', description: 'Old', kind: 'MadeToOrder', categoryId: null, garmentType: 'Kaftan', tags: [], fabrics: [], colours: [], sizes: [], basePrice: 100, currencyCode: 'NGN', productionDays: 5, isFeatured: false, parentDesignId: null, version: 7 };
  const result = await applyStructuredTextDraft({}, user, { type: 'product_description', targetId: target, version: 7, description: 'A tailored kaftan.' }, {
    getDesign: async (_pool, businessId, id) => { assert.equal(businessId, user.businessId); assert.equal(id, target); return current; },
    updateDesign: async (_pool, actor, id, request) => { updated = { actor, id, request }; return { id, description: request.description }; },
  });
  assert.equal(result.applied, true); assert.equal(updated.request.description, 'A tailored kaftan.'); assert.equal(updated.request.basePrice, 100);
});

test('collection-name apply rejects stale versions and does not write', async () => {
  let writes = 0;
  await assert.rejects(() => applyStructuredTextDraft({}, user, { type: 'collection_names', targetId: target, version: 2, name: 'Spring Edit' }, {
    getCollection: async (_pool, businessId) => { assert.equal(businessId, user.businessId); return { version: 3, name: 'Current', description: null, visibility: 'Private', sortOrder: 0 }; },
    updateCollection: async () => { writes += 1; },
  }), (error) => error.code === 'stale_version');
  assert.equal(writes, 0);
});

test('cross-tenant catalog targets are rejected before any update', async () => {
  let writes = 0;
  await assert.rejects(() => applyStructuredTextDraft({}, user, { type: 'product_description', targetId: target, version: 1, description: 'New description' }, {
    getDesign: async (_pool, businessId) => { assert.equal(businessId, 'tenant-a'); const error = new Error('Design not found.'); error.code = 'design_not_found'; throw error; },
    updateDesign: async () => { writes += 1; },
  }), (error) => error.code === 'design_not_found');
  assert.equal(writes, 0);
});
