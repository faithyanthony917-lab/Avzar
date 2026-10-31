import { describe, expect, it } from 'vitest';
import { canGenerateTasks, orderActionAvailability } from '../orders';

describe('orderActionAvailability', () => {
  it('offers delivery only for a Ready order and only to order managers', () => {
    expect(orderActionAvailability('Ready', true, false).deliver).toBe(true);
    expect(orderActionAvailability('Ready', false, true).deliver).toBe(false);
    for (const status of ['Draft', 'Quoted', 'Confirmed', 'InProduction', 'Delivered', 'Cancelled']) {
      expect(orderActionAvailability(status, true, true).deliver).toBe(false);
    }
  });

  it('keeps the existing transitions unchanged', () => {
    expect(orderActionAvailability('Draft', true, false)).toMatchObject({ edit: true, quote: true, confirm: false, cancel: true });
    expect(orderActionAvailability('Quoted', true, true)).toMatchObject({ edit: true, quote: false, confirm: true, cancel: true });
    expect(orderActionAvailability('Delivered', true, true).cancel).toBe(false);
  });
});

describe('canGenerateTasks', () => {
  it('only offers the fallback for an active order that has no tasks and a manager who may create them', () => {
    expect(canGenerateTasks('Confirmed', true, 0)).toBe(true);
    expect(canGenerateTasks('InProduction', true, 0)).toBe(true);
    expect(canGenerateTasks('Confirmed', true, 3)).toBe(false);
    expect(canGenerateTasks('Confirmed', false, 0)).toBe(false);
    expect(canGenerateTasks('Quoted', true, 0)).toBe(false);
    expect(canGenerateTasks('Delivered', true, 0)).toBe(false);
  });
});
