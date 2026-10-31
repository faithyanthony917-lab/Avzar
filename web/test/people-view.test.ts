import { describe, expect, it } from 'vitest';
import { AVATAR_TONES, avatarTone, initials, telHref } from '@/lib/people-view';

describe('initials', () => {
  it('uses the first and last words', () => {
    expect(initials('Amara Okafor')).toBe('AO');
    expect(initials('  kofi   mensah  ')).toBe('KM');
    expect(initials('Nia Wanjiru Kamau')).toBe('NK');
  });
  it('handles one word and empty names', () => {
    expect(initials('Zainab')).toBe('Z');
    expect(initials('   ')).toBe('?');
  });
});

describe('avatarTone', () => {
  it('is stable and within range', () => {
    expect(avatarTone('Amara Okafor')).toBe(avatarTone('  amara okafor '));
    for (const n of ['A', 'Kofi Mensah', 'Zainab Bello', 'Nia Kamau', 'Chuka E.']) {
      const t = avatarTone(n);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(AVATAR_TONES);
    }
  });
});

describe('telHref', () => {
  it('keeps a leading plus and drops spaces and punctuation', () => {
    expect(telHref('+234 803 555 0182')).toBe('tel:+2348035550182');
    expect(telHref('(0803) 555-0182')).toBe('tel:08035550182');
  });
  it('returns null when it cannot be dialled', () => {
    expect(telHref(null)).toBeNull();
    expect(telHref('')).toBeNull();
    expect(telHref('12')).toBeNull();
    expect(telHref('1234567890123456')).toBeNull();
  });
});
