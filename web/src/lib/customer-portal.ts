/** Portal links put the bearer token in the URL fragment so it is not sent in HTTP requests or referrers. */
export function portalTokenFromHash(hash: string): string | null {
  const token = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!token || token.length > 4096 || /[\s#]/.test(token)) return null;
  return token;
}

export interface PortalInvoiceBalance { number: string | null; status: string; balance: number; currencyCode: string }

/**
 * What the customer still owes, per currency. Drafts (no invoice number), cancelled or void invoices and
 * zero or negative balances are left out, so the figure never counts money nobody has asked for.
 */
export function balanceByCurrency(invoices: PortalInvoiceBalance[]): Array<{ currency: string; amount: number }> {
  const totals = new Map<string, number>();
  for (const i of invoices) {
    if (i.number === null || /cancel|void/i.test(i.status) || !(i.balance > 0)) continue;
    totals.set(i.currencyCode, (totals.get(i.currencyCode) ?? 0) + i.balance);
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
