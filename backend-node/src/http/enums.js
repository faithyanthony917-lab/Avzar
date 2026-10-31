import { AppError } from './errors.js';

// Every enum-like string is read trimmed and case-insensitive, and an unknown value is
// 400 `invalid_<field>`. These helpers do that for the routes. They return the canonical spelling.

/** The canonical value when `raw` names one of `values` (ignoring case and surrounding spaces), otherwise undefined. */
export function matchEnum(raw, values) {
  if (typeof raw !== 'string') return undefined;
  const wanted = raw.trim().toLowerCase();
  return values.find((value) => value.toLowerCase() === wanted);
}

/** The canonical value, or 400 `invalid_<field>`. */
export function parseEnum(raw, values, field) {
  const value = matchEnum(raw, values);
  if (value === undefined) throw AppError.badRequest(`invalid_${field}`, `'${raw}' is not a valid ${field}.`);
  return value;
}

/** Query filters that are blank are ignored rather than rejected. */
export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}
