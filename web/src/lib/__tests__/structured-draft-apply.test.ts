import { describe, expect, it } from 'vitest';
import { collectionNameApply, productDescriptionApply } from '../structured-draft-apply';

describe('structured draft apply payloads', () => {
  it('builds a versioned product-description update without including unrelated fields', () => {
    expect(productDescriptionApply('design-1', 4, '  A tailored description. ')).toEqual({
      type: 'product_description', targetId: 'design-1', version: 4, description: 'A tailored description.',
    });
  });
  it('requires a valid collection target, version, and name', () => {
    expect(collectionNameApply('collection-1', 2, ' Spring Edit ')).toEqual({
      type: 'collection_names', targetId: 'collection-1', version: 2, name: 'Spring Edit',
    });
    expect(() => collectionNameApply('', 2, 'Spring Edit')).toThrow();
    expect(() => collectionNameApply('collection-1', 2, 'x')).toThrow();
  });
  it('rejects an empty product description', () => {
    expect(() => productDescriptionApply('design-1', 4, '  ')).toThrow();
  });
});
