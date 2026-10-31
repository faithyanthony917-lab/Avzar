export type StockSnapshot = { onHand: number; reserved: number; reorderLevel: number };

export function availableStock(stock: StockSnapshot): number {
  return Math.max(0, stock.onHand - stock.reserved);
}

export function stockLevel(stock: StockSnapshot): 'out-of-stock' | 'low-stock' | 'in-stock' {
  const available = availableStock(stock);
  if (available <= 0) return 'out-of-stock';
  if (available <= Math.max(0, stock.reorderLevel)) return 'low-stock';
  return 'in-stock';
}

export function validStockQuantity(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
