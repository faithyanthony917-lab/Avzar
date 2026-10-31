import { describe, expect, it } from 'vitest';
import { parseEmailLink } from '../src/lib/email-links';

const uid = '3f2b8c1e-0d4a-4b7e-9a65-1c2d3e4f5a6b';
// What accountService.js issues: base64url payload + '.' + base64url signature, put in the URL with encodeURIComponent.
const token = 'eyJ1IjoiYWJjIiwicCI6InJlc2V0X3Bhc3N3b3JkIn0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';

describe('parseEmailLink', () => {
  it('reads userId and token as the emails build them', () => expect(parseEmailLink({ userId: uid, token })).toEqual({ userId: uid, token }));
  it('takes the first value of a repeated parameter', () => expect(parseEmailLink({ userId: [uid, 'x'], token: [token, 'y'] })).toEqual({ userId: uid, token }));
  it('accepts an upper-case user id', () => expect(parseEmailLink({ userId: uid.toUpperCase(), token })?.userId).toBe(uid.toUpperCase()));
  it.each([
    [{}], [{ userId: uid }], [{ token }], [{ userId: '', token }], [{ userId: uid, token: '' }],
    [{ userId: 'not-a-uuid', token }], [{ userId: `${uid}x`, token }], [{ userId: uid, token: 'has space' }], [{ userId: uid, token: 'a'.repeat(2001) }],
  ])('refuses %j', (params) => expect(parseEmailLink(params)).toBeNull());
  it('allows a token of exactly 2000 characters (the API limit)', () => expect(parseEmailLink({ userId: uid, token: 'a'.repeat(2000) })).not.toBeNull());
});
