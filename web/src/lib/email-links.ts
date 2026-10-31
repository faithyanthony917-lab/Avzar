// Reads the links the API emails: /reset-password?userId=<uuid>&token=<token> and /verify-email?userId=<uuid>&token=<token>
// (backend-node/src/auth/accountService.js:153 and :183). Limits mirror accountRoutes.js:11-13. No imports: unit-tested in test/email-links.test.ts.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_MAX = 2000;

export interface EmailLink { userId: string; token: string }

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Returns the userId and token, or null when either is missing or malformed (so the page can say "this link is not valid" without calling the API). */
export function parseEmailLink(params: { userId?: string | string[]; token?: string | string[] }): EmailLink | null {
  const userId = first(params.userId)?.trim();
  const token = first(params.token);
  if (!userId || !UUID.test(userId)) return null;
  if (!token || token.length > TOKEN_MAX || /\s/.test(token)) return null;
  return { userId, token };
}
