/** Pure helpers for the Customers list cards. No I/O, so they are unit-tested without rendering. */

/** Up to two capital letters: the first letters of the first and last words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export const AVATAR_TONES = 5;

/** A stable tone (0 to 4) per name, so a customer keeps the same avatar colour on every visit. */
export function avatarTone(name: string): number {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % AVATAR_TONES;
}

/** A `tel:` link for a phone number, or null when there are too few digits to dial. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 15) return null;
  return `tel:${phone.trim().startsWith('+') ? '+' : ''}${digits}`;
}
