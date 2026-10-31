// Pure helpers for the "Your data" page. No imports, so they run anywhere (unit-tested in test/account-data.test.ts).
// Mirrors backend-node/src/auth/accountRoutes.js: GET /api/account/export and POST /api/account/delete.

/** The body POST /api/account/delete expects: the password, plus one second factor only when two-step sign-in is on. */
export interface DeleteAccountBody { password: string; twoFactorCode?: string; recoveryCode?: string }

export type DeleteFactor = 'authenticator' | 'recovery';

/** Day-stamped file name for the downloaded export, e.g. avzar-account-2026-10-27.json (UTC day, matching the API's exportedAtUtc). */
export function exportFileName(now: Date = new Date()): string {
  return `avzar-account-${now.toISOString().slice(0, 10)}.json`;
}

/** First problem that stops the delete form being sent, or null. The API still re-checks everything. */
export function deleteAccountProblem(input: { password: string; twoFactorEnabled: boolean; factor: DeleteFactor; code: string; confirmed: boolean }): string | null {
  if (!input.password) return 'Enter your password.';
  if (input.twoFactorEnabled) {
    const code = input.code.replace(/\s+/g, '');
    if (input.factor === 'authenticator' && !/^\d{6}$/.test(code)) return 'Enter the 6-digit code from your authenticator app.';
    if (input.factor === 'recovery' && code.length === 0) return 'Enter one of your recovery codes.';
  }
  if (!input.confirmed) return 'Tick the box to confirm you want to delete your account.';
  return null;
}

export function deleteAccountBody(input: { password: string; twoFactorEnabled: boolean; factor: DeleteFactor; code: string }): DeleteAccountBody {
  const body: DeleteAccountBody = { password: input.password };
  if (!input.twoFactorEnabled) return body;
  const code = input.code.replace(/\s+/g, '');
  if (input.factor === 'authenticator') body.twoFactorCode = code;
  else body.recoveryCode = input.code.trim();
  return body;
}
