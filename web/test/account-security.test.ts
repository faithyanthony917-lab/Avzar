import { describe, expect, it } from 'vitest';
import { changePasswordProblem, disableTwoFactorBody, groupSetupKey, normalizeAuthenticatorCode, passwordProblem, safeOtpAuthUri } from '../src/lib/account-security';

describe('passwordProblem (same limits as the API: 10 to 128)', () => {
  it('accepts the boundaries', () => {
    expect(passwordProblem('x'.repeat(10))).toBeNull();
    expect(passwordProblem('x'.repeat(128))).toBeNull();
  });
  it('rejects too short and too long', () => {
    expect(passwordProblem('x'.repeat(9))).toMatch(/at least 10/);
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/);
  });
});

describe('changePasswordProblem', () => {
  const good = 'correct horse battery';
  it('needs the current password', () => expect(changePasswordProblem('', good, good)).toMatch(/current password/));
  it('applies the password rule to the new one', () => expect(changePasswordProblem('old-password', 'short', 'short')).toMatch(/at least 10/));
  it('needs the confirmation to match', () => expect(changePasswordProblem('old-password', good, `${good}!`)).toMatch(/do not match/));
  it('refuses to reuse the current password', () => expect(changePasswordProblem(good, good, good)).toMatch(/different/));
  it('accepts a valid change', () => expect(changePasswordProblem('old-password', good, good)).toBeNull());
});

describe('normalizeAuthenticatorCode', () => {
  it.each([['123456', '123456'], [' 123 456 ', '123456']])('accepts %j', (raw, want) => expect(normalizeAuthenticatorCode(raw)).toBe(want));
  it.each([[''], ['12345'], ['1234567'], ['12a456'], ['abcde-fghij']])('rejects %j', (raw) => expect(normalizeAuthenticatorCode(raw)).toBeNull());
});

describe('disableTwoFactorBody', () => {
  it('needs the password', () => expect(disableTwoFactorBody('', 'authenticator', '123456')).toEqual({ ok: false, error: 'Enter your current password.' }));
  it('sends password + code for an authenticator code', () => expect(disableTwoFactorBody('pw', 'authenticator', '123 456')).toEqual({ ok: true, body: { password: 'pw', code: '123456' } }));
  it('rejects a malformed authenticator code', () => expect(disableTwoFactorBody('pw', 'authenticator', '12')).toMatchObject({ ok: false }));
  it('sends password + recoveryCode, trimmed but otherwise as typed', () => expect(disableTwoFactorBody('pw', 'recovery', '  abcde-12345 ')).toEqual({ ok: true, body: { password: 'pw', recoveryCode: 'abcde-12345' } }));
  it('rejects an empty or oversized recovery code', () => {
    expect(disableTwoFactorBody('pw', 'recovery', '   ')).toMatchObject({ ok: false });
    expect(disableTwoFactorBody('pw', 'recovery', 'a'.repeat(81))).toMatchObject({ ok: false });
  });
});

describe('groupSetupKey', () => {
  it('groups in fours', () => expect(groupSetupKey('ABCDEFGHIJKL')).toBe('ABCD EFGH IJKL'));
  it('handles a partial last group and stray spaces', () => expect(groupSetupKey('ABCD EFGHIJ')).toBe('ABCD EFGH IJ'));
});

describe('safeOtpAuthUri', () => {
  const ok = 'otpauth://totp/Avzar:me%40x.com?secret=ABCDEFGH&issuer=Avzar&digits=6';
  it('keeps a plain otpauth totp link', () => expect(safeOtpAuthUri(ok)).toBe(ok));
  it.each([['javascript:alert(1)'], ['https://evil.example'], ['otpauth://hotp/x'], ['otpauth://totp/a b'], ['otpauth://totp/a"onclick=x'], [42], [undefined]])('drops %j', (v) => expect(safeOtpAuthUri(v)).toBeNull());
});
