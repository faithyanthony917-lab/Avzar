import { describe, expect, it } from 'vitest';
import { isValidBusinessWeek, normalizeTimeInput, type BusinessDayHours } from '../src/lib/business-schedule';

const validWeek = (): BusinessDayHours[] => Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  isOpen: dayOfWeek > 0 && dayOfWeek < 6,
  opensAt: dayOfWeek > 0 && dayOfWeek < 6 ? '09:00' : null,
  closesAt: dayOfWeek > 0 && dayOfWeek < 6 ? '17:00' : null,
}));

describe('business schedule validation', () => {
  it('accepts seven distinct days with valid open-day times', () => expect(isValidBusinessWeek(validWeek())).toBe(true));
  it('rejects missing, duplicate, or out-of-range weekdays', () => {
    expect(isValidBusinessWeek(validWeek().slice(0, 6))).toBe(false);
    const duplicate = validWeek(); duplicate[6] = { ...duplicate[6]!, dayOfWeek: 5 };
    expect(isValidBusinessWeek(duplicate)).toBe(false);
    const invalid = validWeek(); invalid[0] = { ...invalid[0]!, dayOfWeek: 7 };
    expect(isValidBusinessWeek(invalid)).toBe(false);
  });
  it('rejects missing or reversed opening times and times on a closed day', () => {
    const missing = validWeek(); missing[1] = { ...missing[1]!, opensAt: null };
    expect(isValidBusinessWeek(missing)).toBe(false);
    const reversed = validWeek(); reversed[1] = { ...reversed[1]!, opensAt: '18:00', closesAt: '09:00' };
    expect(isValidBusinessWeek(reversed)).toBe(false);
    const closedWithTimes = validWeek(); closedWithTimes[0] = { ...closedWithTimes[0]!, opensAt: '09:00', closesAt: '17:00' };
    expect(isValidBusinessWeek(closedWithTimes)).toBe(false);
  });
  it('normalizes API time strings for HTML time inputs', () => {
    expect(normalizeTimeInput('09:30:00')).toBe('09:30');
    expect(normalizeTimeInput(null)).toBe('');
  });
});
