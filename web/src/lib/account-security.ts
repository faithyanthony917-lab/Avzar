// Pure helpers for the account security page. No imports, so they run anywhere (and are unit-tested in test/account-security.test.ts).
// Limits mirror backend-node/src/auth/accountRoutes.js:10-19.

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** GET /api/account/security (accountService.js getSecurity). */
export interface SecuritySummary { emailConfirmed: boolean; twoFactorEnabled: boolean; recoveryCodesLeft: number; activeSessions: number }

/** GET /api/account/sessions (accountService.js listSessions). Browser sign-ins are not listed: the API filters out DeviceName 'Browser'. */
export interface DeviceSession { id: string; deviceName: string; createdAtUtc: string; lastUsedAtUtc: string; expiresAtUtc: string }

/** POST /api/account/two-factor/setup. */
export interface TwoFactorSetup { sharedKey: string; otpAuthUri: string }

/** The same rule the API and the register form apply to a new password. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

/** Client-side checks for change-password. Returns the first problem, or null when the form can be sent. */
export function changePasswordProblem(current: string, next: string, confirm: string): string | null {
  if (!current) return 'Enter your current password.';
  const rule = passwordProblem(next);
  if (rule) return rule;
  if (next !== confirm) return 'The new password and the confirmation do not match.';
  if (next === current) return 'Choose a new password that is different from the current one.';
  return null;
}

/** An authenticator code: spaces are ignored (people type "123 456"); it must then be exactly 6 digits. */
export function normalizeAuthenticatorCode(raw: string): string | null {
  const code = raw.replace(/\s+/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}

export type SecondFactorMethod = 'authenticator' | 'recovery';

/** Body for POST /api/account/two-factor/disable (disable2fa schema: password, then code OR recoveryCode). Returns an error string when the input is unusable. */
export function disableTwoFactorBody(password: string, method: SecondFactorMethod, value: string): { ok: true; body: { password: string; code?: string; recoveryCode?: string } } | { ok: false; error: string } {
  if (!password) return { ok: false, error: 'Enter your current password.' };
  if (method === 'authenticator') {
    const code = normalizeAuthenticatorCode(value);
    if (!code) return { ok: false, error: 'Enter the 6-digit code from your authenticator app.' };
    return { ok: true, body: { password, code } };
  }
  const recoveryCode = value.trim();
  if (!recoveryCode) return { ok: false, error: 'Enter one of your recovery codes.' };
  if (recoveryCode.length > 80) return { ok: false, error: 'That recovery code is too long.' };
  return { ok: true, body: { password, recoveryCode } }; // sent as typed: the API matches the stored text exactly
}

/** The setup key in groups of four, easier to read and type: "ABCD EFGH ...". */
export function groupSetupKey(key: string): string {
  return key.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/** Only a plain otpauth://totp link is ever put into an href. Anything else (javascript:, data:, odd characters) is dropped. */
export function safeOtpAuthUri(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('otpauth://totp/') || uri.length > 512) return null;
  if (/[\s"'<>\\]/.test(uri)) return null;
  return uri;
}
