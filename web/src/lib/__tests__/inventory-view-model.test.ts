import { describe, expect, it } from 'vitest';
import { availableStock, stockLevel, validStockQuantity } from '../inventory-view-model';

describe('inventory view model', () => {
  it('calculates available stock without exposing a negative value', () => {
    expect(availableStock({ onHand: 20, reserved: 7, reorderLevel: 3 })).toBe(13);
    expect(availableStock({ onHand: 2, reserved: 5, reorderLevel: 1 })).toBe(0);
  });
  it('distinguishes out, low and normal stock', () => {
    expect(stockLevel({ onHand: 0, reserved: 0, reorderLevel: 5 })).toBe('out-of-stock');
    expect(stockLevel({ onHand: 5, reserved: 1, reorderLevel: 4 })).toBe('low-stock');
    expect(stockLevel({ onHand: 20, reserved: 1, reorderLevel: 4 })).toBe('in-stock');
  });
  it('rejects zero, negative and non-finite stock quantities', () => {
    expect(validStockQuantity(0)).toBe(false);
    expect(validStockQuantity(-1)).toBe(false);
    expect(validStockQuantity(Number.NaN)).toBe(false);
    expect(validStockQuantity(0.25)).toBe(true);
  });
});
