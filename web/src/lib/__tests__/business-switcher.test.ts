import { describe, expect, it } from 'vitest';
import { normalizeMemberships, switchTargets } from '../business-switcher';

const a = { businessId: 'a', businessName: 'Alpha', isOwner: true, isCurrent: true };
const b = { businessId: 'b', businessName: 'Bravo', isOwner: false, isCurrent: false };

describe('business switcher helpers', () => {
  it('keeps well-formed memberships and drops malformed or duplicate entries', () => {
    const out = normalizeMemberships({ businesses: [a, { businessId: 1 }, null, { businessId: '', businessName: 'x' }, a, { businessId: 'c', businessName: 'Charlie' }] });
    expect(out.map((m) => m.businessId)).toEqual(['a', 'c']);
    expect(out[1]).toEqual({ businessId: 'c', businessName: 'Charlie', isOwner: false, isCurrent: false });
  });
  it('returns an empty list for unexpected payloads', () => {
    expect(normalizeMemberships(undefined)).toEqual([]);
    expect(normalizeMemberships({})).toEqual([]);
    expect(normalizeMemberships({ businesses: 'nope' })).toEqual([]);
  });
  it('offers only other businesses, and nothing for a single-business user', () => {
    expect(switchTargets([a, b], 'a').map((m) => m.businessId)).toEqual(['b']);
    expect(switchTargets([a], 'a')).toEqual([]);
  });
});
