export const CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR', 'CAD', 'AUD', 'INR', 'AED'] as const;

const BY_ZONE: Record<string, string> = {
  'Africa/Lagos': 'NGN', 'Africa/Accra': 'GHS', 'Africa/Nairobi': 'KES', 'Africa/Johannesburg': 'ZAR',
  'Europe/London': 'GBP', 'Asia/Kolkata': 'INR', 'Asia/Dubai': 'AED', 'America/Toronto': 'CAD', 'Australia/Sydney': 'AUD',
};

/** A sensible starting currency for a time zone; the person can change it. */
export function defaultCurrency(timeZone: string): string {
  const hit = BY_ZONE[timeZone];
  if (hit) return hit;
  if (timeZone.startsWith('Europe/')) return 'EUR';
  return 'USD';
}
