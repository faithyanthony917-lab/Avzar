// Email address normalisation and header-safety rules.

// A plain address only: dot-atom local part, a dotted host. No display names, no quotes, no whitespace.
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** The form in which addresses are stored in and compared against the suppression list: trimmed, lower-case. */
export function suppressionKey(address) {
  return String(address).trim().toLowerCase();
}

/** Accepts a plain address only. Returns the trimmed address, or null when it is not acceptable. */
export function tryNormalize(input) {
  if (typeof input !== 'string' || input.trim() === '') return null;
  const s = input.trim();
  if (s.length > 254 || /[\r\n ,;<>"]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at !== s.indexOf('@')) return null;
  const local = s.slice(0, at);
  const host = s.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local)) return null;
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63 || !HOST_LABEL.test(label))) return null;
  return s;
}

/** True for a single-line header value (no CR or LF). */
export function isSafeHeaderValue(value) {
  return typeof value === 'string' && !/[\r\n]/.test(value);
}
