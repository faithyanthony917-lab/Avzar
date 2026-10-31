// Exact decimal money helpers. Rules: decimal, 2 places, half away from zero, without ever
// multiplying or dividing floating-point numbers: every JS number is read as the decimal text it prints as
// (so 14.5 is exactly 14.5, 2.675 is exactly 2.675), and arithmetic is done on BigInt.

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** value = n / 10^s with s >= 0. Accepts numbers, numeric strings (pg returns numeric as text) and bigint. */
export function parseDecimal(value) {
  if (typeof value === 'bigint') return { n: value, s: 0 };
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Not a finite number.');
  const match = DECIMAL.exec(String(value).trim());
  if (!match) throw new TypeError(`Not a decimal number: ${String(value)}`);
  const fraction = match[3] ?? '';
  let n = BigInt(`${match[2]}${fraction}`);
  let s = fraction.length - Number(match[4] ?? 0);
  if (s < 0) { n *= 10n ** BigInt(-s); s = 0; }
  return { n: match[1] === '-' ? -n : n, s };
}

/** Rounds n / 10^s to `places` decimal places, half away from zero; returns the BigInt scaled by 10^places. */
export function roundScaled(n, s, places = 2) {
  if (s <= places) return n * 10n ** BigInt(places - s);
  const divisor = 10n ** BigInt(s - places);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  let quotient = abs / divisor;
  if ((abs % divisor) * 2n >= divisor) quotient += 1n;
  return negative ? -quotient : quotient;
}

/** Number of significant decimal places (trailing zeros ignored). */
export function decimalPlaces(value) {
  const { n, s } = parseDecimal(value);
  if (n === 0n) return 0;
  let places = s;
  let rest = n < 0n ? -n : n;
  while (places > 0 && rest % 10n === 0n) { rest /= 10n; places -= 1; }
  return places;
}

export const hasAtMostPlaces = (value, places = 2) => decimalPlaces(value) <= places;

/** value rounded to cents (BigInt), half away from zero. */
export function toCents(value) {
  const { n, s } = parseDecimal(value);
  return roundScaled(n, s, 2);
}

export const centsToNumber = (cents) => Number(cents) / 100;

export function centsToString(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** R(v): round to 2 places, half away from zero. */
export const roundMoney = (value) => centsToNumber(toCents(value));

/** R(a * b) in cents. */
export function mulCents(a, b) {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  return roundScaled(left.n * right.n, left.s + right.s, 2);
}

/** R(amount * percent / 100) in cents, where `amount` is a money value and `percent` any decimal. */
export function percentOfCents(amountCents, percent) {
  const rate = parseDecimal(percent);
  return roundScaled(amountCents * rate.n, rate.s + 4, 2);
}

export const mulMoney = (a, b) => centsToNumber(mulCents(a, b));
export const percentOfMoney = (amount, percent) => centsToNumber(percentOfCents(toCents(amount), percent));

export function sumMoney(values) {
  return centsToNumber(values.reduce((sum, value) => sum + toCents(value), 0n));
}

/** first - rest[0] - rest[1] ..., exact. */
export function subtractMoney(first, ...rest) {
  return centsToNumber(rest.reduce((total, value) => total - toCents(value), toCents(first)));
}

export const addMoney = (...values) => sumMoney(values);
