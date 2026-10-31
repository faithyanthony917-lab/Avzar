/** Formats a price in the given currency. With no currency code it shows the plain number (it never assumes one); with an unknown code it falls back to plain text. */
export function money(amount: number | null | undefined, currency: string | null | undefined): string | null {
  if (amount === null || amount === undefined) return null;
  if (!currency) return new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(amount);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

/** Plain-text paragraphs. Never HTML: React escapes every string it renders. */
export function paragraphs(text: unknown): string[] {
  return typeof text === 'string' ? text.split(/\r?\n+/).map((p) => p.trim()).filter(Boolean) : [];
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const bool = (v: unknown): boolean => v === true;
export const list = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
