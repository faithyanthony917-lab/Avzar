// Port of EmailRetryPolicy: 30s, 2m, 8m, ~32m, ~2h, then capped at 6h.
const SIX_HOURS_SECONDS = 6 * 60 * 60;

export function nextDelayMs(attemptsMade) {
  const attempts = attemptsMade < 1 ? 1 : attemptsMade;
  const seconds = 30 * 4 ** Math.min(attempts - 1, 8);
  return Math.min(seconds, SIX_HOURS_SECONDS) * 1000;
}
