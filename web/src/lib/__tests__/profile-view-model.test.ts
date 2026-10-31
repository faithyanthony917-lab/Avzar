import { describe, expect, it } from 'vitest';
import { profileChanged, validateProfile } from '../profile-view-model';

describe('validateProfile', () => {
  it('trims both fields and turns a blank phone into null', () => {
    expect(validateProfile({ fullName: '  Ada Obi ', phone: ' +234 801 234 5678 ' })).toEqual({ ok: true, body: { fullName: 'Ada Obi', phone: '+234 801 234 5678' } });
    expect(validateProfile({ fullName: 'Ada Obi', phone: '   ' })).toEqual({ ok: true, body: { fullName: 'Ada Obi', phone: null } });
  });
  it('accepts common phone shapes', () => {
    for (const phone of ['08012345678', '(0801) 234-5678', '+1.555.123.4567']) expect(validateProfile({ fullName: 'Ada Obi', phone }).ok).toBe(true);
  });
  it('asks for a real name', () => {
    for (const fullName of ['', ' ', 'A', 'x'.repeat(121)]) {
      const check = validateProfile({ fullName, phone: '' });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.errors.fullName).toBeTruthy();
    }
  });
  it('rejects text and over-long phone numbers', () => {
    for (const phone of ['call me', '12', '1'.repeat(41)]) {
      const check = validateProfile({ fullName: 'Ada Obi', phone });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.errors.phone).toBeTruthy();
    }
  });
});

describe('profileChanged', () => {
  const original = { fullName: 'Ada Obi', email: 'ada@example.test', phone: null };
  it('is false when nothing changed, treating missing and blank phone alike', () => {
    expect(profileChanged(original, { fullName: 'Ada Obi', phone: null })).toBe(false);
  });
  it('is true for a new name or phone', () => {
    expect(profileChanged(original, { fullName: 'Ada B. Obi', phone: null })).toBe(true);
    expect(profileChanged(original, { fullName: 'Ada Obi', phone: '08012345678' })).toBe(true);
    expect(profileChanged({ ...original, phone: '0801 234 5678' }, { fullName: 'Ada Obi', phone: null })).toBe(true);
  });
});
