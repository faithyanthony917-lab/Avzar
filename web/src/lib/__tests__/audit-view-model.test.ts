import { describe, expect, it } from 'vitest';
import { auditDetailsText, auditPageCount } from '../audit-view-model';

describe('audit view model', () => {
  it('formats object and JSON-string details for readable display', () => {
    expect(auditDetailsText({ changed: ['status'], count: 2 })).toContain('"count": 2');
    expect(auditDetailsText('{"reason":"approved"}')).toContain('"reason": "approved"');
  });

  it('keeps plain text and handles missing details', () => {
    expect(auditDetailsText('legacy note')).toBe('legacy note');
    expect(auditDetailsText(null)).toBe('—');
  });

  it('calculates pagination safely', () => {
    expect(auditPageCount(51, 25)).toBe(3);
    expect(auditPageCount(0, 25)).toBe(0);
    expect(auditPageCount(12, 0)).toBe(0);
  });
});
