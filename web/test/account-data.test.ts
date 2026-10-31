import { describe, expect, it } from 'vitest';
import { deleteAccountBody, deleteAccountProblem, exportFileName } from '../src/lib/account-data';

describe('exportFileName', () => {
  it('uses the UTC day', () => expect(exportFileName(new Date('2026-10-27T23:30:00Z'))).toBe('avzar-account-2026-10-27.json'));
});

describe('deleteAccountProblem', () => {
  const ok = { password: 'secret-password', twoFactorEnabled: false, factor: 'authenticator' as const, code: '', confirmed: true };
  it('accepts a password and the confirmation when two-step sign-in is off', () => expect(deleteAccountProblem(ok)).toBeNull());
  it('needs a password', () => expect(deleteAccountProblem({ ...ok, password: '' })).toMatch(/password/i));
  it('needs the confirmation box', () => expect(deleteAccountProblem({ ...ok, confirmed: false })).toMatch(/confirm/i));
  it('needs a 6-digit code when two-step sign-in is on, ignoring spaces', () => {
    const on = { ...ok, twoFactorEnabled: true };
    expect(deleteAccountProblem({ ...on, code: '12 34' })).toMatch(/6-digit/);
    expect(deleteAccountProblem({ ...on, code: '123 456' })).toBeNull();
  });
  it('needs a recovery code when that method is chosen', () => {
    const on = { ...ok, twoFactorEnabled: true, factor: 'recovery' as const };
    expect(deleteAccountProblem({ ...on, code: ' ' })).toMatch(/recovery/i);
    expect(deleteAccountProblem({ ...on, code: 'abcd-efgh' })).toBeNull();
  });
});

describe('deleteAccountBody', () => {
  it('sends only the password when two-step sign-in is off', () => {
    expect(deleteAccountBody({ password: 'p', twoFactorEnabled: false, factor: 'authenticator', code: '123456' })).toEqual({ password: 'p' });
  });
  it('sends the matching second factor', () => {
    expect(deleteAccountBody({ password: 'p', twoFactorEnabled: true, factor: 'authenticator', code: '123 456' })).toEqual({ password: 'p', twoFactorCode: '123456' });
    expect(deleteAccountBody({ password: 'p', twoFactorEnabled: true, factor: 'recovery', code: ' abcd-efgh ' })).toEqual({ password: 'p', recoveryCode: 'abcd-efgh' });
  });
});
