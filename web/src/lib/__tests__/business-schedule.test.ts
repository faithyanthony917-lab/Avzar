import { describe, expect, it } from 'vitest';
import { isValidBusinessWeek, normalizeTimeInput, type BusinessDayHours } from '../business-schedule';

const week = (): BusinessDayHours[] => Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek, isOpen: dayOfWeek < 6, opensAt: dayOfWeek < 6 ? '09:00' : null, closesAt: dayOfWeek < 6 ? '17:00' : null,
}));

describe('business schedule validation', () => {
  it('accepts seven unique days with valid hours', () => expect(isValidBusinessWeek(week())).toBe(true));
  it('rejects a missing day and duplicate days', () => {
    expect(isValidBusinessWeek(week().slice(1))).toBe(false);
    const duplicate = week(); duplicate[6] = { ...duplicate[6]!, dayOfWeek: 5 };
    expect(isValidBusinessWeek(duplicate)).toBe(false);
  });
  it('rejects invalid or reversed opening hours', () => {
    const invalid = week(); invalid[0] = { ...invalid[0]!, opensAt: '17:00', closesAt: '09:00' };
    expect(isValidBusinessWeek(invalid)).toBe(false);
    const malformed = week(); malformed[0] = { ...malformed[0]!, opensAt: '9am' };
    expect(isValidBusinessWeek(malformed)).toBe(false);
  });
  it('requires closed days to have null times', () => {
    const invalid = week(); invalid[6] = { ...invalid[6]!, opensAt: '09:00' };
    expect(isValidBusinessWeek(invalid)).toBe(false);
  });
  it('normalizes time values for input controls', () => {
    expect(normalizeTimeInput('09:30:00')).toBe('09:30');
    expect(normalizeTimeInput(null)).toBe('');
  });
});
