/** Accepts only a same-site relative path (e.g. /dashboard or /accept-invite?token=x); anything else falls back. Stops open redirects via ?next=. */
export function safeNext(raw: string | string[] | undefined | null, fallback = '/dashboard'): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || !v) return fallback;
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /[\u0000-\u001f]/.test(v)) return fallback;
  return v;
}
