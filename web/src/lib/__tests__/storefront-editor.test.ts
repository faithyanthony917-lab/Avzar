import { describe, expect, it } from 'vitest';
import { reorderItems } from '../storefront-editor';

describe('storefront section reordering', () => {
  it('moves a section down without mutating the original list', () => {
    const source = ['hero', 'gallery', 'contact'];
    expect(reorderItems(source, 0, 2)).toEqual(['gallery', 'contact', 'hero']);
    expect(source).toEqual(['hero', 'gallery', 'contact']);
  });
  it('moves a section up and supports no-op and invalid positions', () => {
    expect(reorderItems(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(reorderItems(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(reorderItems(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
    expect(reorderItems(['a', 'b'], 0, 8)).toEqual(['a', 'b']);
  });
});
