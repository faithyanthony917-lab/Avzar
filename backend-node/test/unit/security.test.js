import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { verifyIdentityHash, verifyPassword } from '../../src/security/passwordHasher.js';
import { decide, RefreshDecision, nextIdleExpiry, tryParseToken } from '../../src/security/sessionRules.js';
import { issueAccessToken, verifyAccessToken } from '../../src/security/jwt.js';
import { newCsrfToken, isValidCsrfToken, csrfProtection } from '../../src/security/csrf.js';
import { AppError, problemBody } from '../../src/http/errors.js';

// NOTE: no .NET runtime is available here, so these vectors are built from the documented Identity layout, not from a real .NET hash.
const v3 = (pw, iter = 100000, prf = 2, digest = 'sha512') => {
  const salt = randomBytes(16), key = pbkdf2Sync(pw, salt, iter, 32, digest);
  const h = Buffer.alloc(13); h[0] = 1; h.writeUInt32BE(prf, 1); h.writeUInt32BE(iter, 5); h.writeUInt32BE(16, 9);
  return Buffer.concat([h, salt, key]).toString('base64');
};
test('identity v3 hash verifies and rejects', async () => {
  const h = v3('correct horse battery');
  assert.equal(verifyIdentityHash(h, 'correct horse battery'), true);
  assert.equal(verifyIdentityHash(h, 'wrong'), false);
  assert.deepEqual(await verifyPassword(h, 'correct horse battery'), { ok: true, needsRehash: true });
  assert.deepEqual(await verifyPassword(h, 'nope'), { ok: false, needsRehash: false });
});
test('identity v3 sha256 and v2 formats; garbage is rejected', () => {
  assert.equal(verifyIdentityHash(v3('pw-sha256-ok', 10000, 1, 'sha256'), 'pw-sha256-ok'), true);
  const salt = randomBytes(16), key = pbkdf2Sync('legacy-pass', salt, 1000, 32, 'sha1');
  assert.equal(verifyIdentityHash(Buffer.concat([Buffer.from([0]), salt, key]).toString('base64'), 'legacy-pass'), true);
  for (const bad of ['', 'AAAA', '!!!', Buffer.from([1, 0, 0]).toString('base64')]) assert.equal(verifyIdentityHash(bad, 'x'), false);
});

const s = (o = {}) => ({ currentTokenHash: 'cur', previousTokenHash: null, revokedAtUtc: null, idleExpiresAtUtc: new Date(Date.now() + 1e6), absoluteExpiresAtUtc: new Date(Date.now() + 1e7), ...o });
test('refresh rotation decisions', () => {
  assert.equal(decide(s(), 'cur'), RefreshDecision.Rotate);
  assert.equal(decide(s({ previousTokenHash: 'old' }), 'old'), RefreshDecision.ReuseDetected);
  assert.equal(decide(s(), 'zzz'), RefreshDecision.Unknown);
  assert.equal(decide(s({ revokedAtUtc: new Date() }), 'cur'), RefreshDecision.Revoked);
  assert.equal(decide(s({ idleExpiresAtUtc: new Date(Date.now() - 1) }), 'cur'), RefreshDecision.Expired);
  const now = new Date(), abs = new Date(now.getTime() + 1000);
  assert.deepEqual(nextIdleExpiry(now, 5000, abs), abs);
});
test('refresh token parsing', () => {
  const id = 'a'.repeat(32), secret = 'x'.repeat(20);
  assert.equal(tryParseToken(`${id}.${secret}`).sessionId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  for (const bad of [null, '', `${id}.short`, `${'g'.repeat(32)}.${secret}`, `${id}${secret}`]) assert.equal(tryParseToken(bad), null);
});

const auth = { jwtSigningKey: 'k'.repeat(40), jwtIssuer: 'avzar-api', jwtAudience: 'avzar-mobile', accessTokenMinutes: 10 };
const ids = { userId: 'u1', businessId: 'b1', sessionId: 's1' };
test('jwt round trip and rejections', () => {
  const { token } = issueAccessToken(auth, ids);
  assert.deepEqual(verifyAccessToken(auth, token), ids);
  assert.equal(verifyAccessToken({ ...auth, jwtAudience: 'x' }, token), null);
  assert.equal(verifyAccessToken(auth, token, new Date(Date.now() + 11 * 60000)), null);
  const [h, b, sg] = token.split('.');
  assert.equal(verifyAccessToken(auth, `${h}.${b}.${sg.slice(0, -2)}AA`), null);
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${b}.`;
  assert.equal(verifyAccessToken(auth, none), null);
  assert.throws(() => issueAccessToken({ ...auth, jwtSigningKey: 'short' }, ids), (e) => e.status === 503 && e.code === 'mobile_auth_not_configured');
});

const run = (mw, req) => new Promise((r) => mw(req, {}, (e) => r(e)));
const mkreq = (method, cookie, header, authz) => ({ method, cookies: { 'tailoring.csrf': cookie }, get: (n) => ({ 'x-xsrf-token': header, authorization: authz })[n.toLowerCase()] });
test('csrf: safe methods, bearer exemption, double submit', async () => {
  const secret = 'sec'.repeat(10), mw = csrfProtection({ secret }), t = newCsrfToken(secret);
  assert.ok(isValidCsrfToken(t, secret)); assert.ok(!isValidCsrfToken(t, 'other'));
  assert.equal(await run(mw, mkreq('GET')), undefined);
  assert.equal(await run(mw, mkreq('POST', t, t)), undefined);
  assert.equal(await run(mw, mkreq('POST', undefined, undefined, 'Bearer abc')), undefined);
  for (const [c, h] of [[undefined, undefined], [t, undefined], [t, newCsrfToken(secret)], ['forged.x', 'forged.x']]) {
    const e = await run(mw, mkreq('DELETE', c, h)); assert.ok(e instanceof AppError); assert.equal(e.code, 'invalid_csrf'); assert.equal(e.status, 400);
  }
});
test('problem body shape', () => assert.deepEqual(problemBody(AppError.conflict('x', 'y', { choices: [1] })), { type: 'https://httpstatuses.io/409', title: 'y', status: 409, code: 'x', choices: [1] }));
