import { describe, expect, it } from 'vitest';
import { canReviewLeave, intervalsOverlap, validLeaveInterval } from '../worker-schedule-view-model';

describe('worker schedule view model', () => {
  it('requires a valid positive leave interval', () => {
    expect(validLeaveInterval('2026-11-01T09:00:00Z', '2026-11-01T17:00:00Z')).toBe(true);
    expect(validLeaveInterval('2026-11-01T17:00:00Z', '2026-11-01T09:00:00Z')).toBe(false);
    expect(validLeaveInterval('bad-date', '2026-11-01T09:00:00Z')).toBe(false);
  });
  it('detects overlapping intervals but treats adjacent intervals as non-overlapping', () => {
    expect(intervalsOverlap('2026-11-01T09:00Z', '2026-11-01T12:00Z', '2026-11-01T11:00Z', '2026-11-01T13:00Z')).toBe(true);
    expect(intervalsOverlap('2026-11-01T09:00Z', '2026-11-01T12:00Z', '2026-11-01T12:00Z', '2026-11-01T13:00Z')).toBe(false);
  });
  it('only offers review actions for pending requests', () => {
    expect(canReviewLeave('Pending')).toBe(true);
    expect(canReviewLeave('Approved')).toBe(false);
    expect(canReviewLeave('Rejected')).toBe(false);
  });
});
