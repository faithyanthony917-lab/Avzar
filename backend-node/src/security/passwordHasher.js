// Verifies hashes already stored in AspNetUsers.PasswordHash (ASP.NET Core Identity v2 and v3 formats) so existing users can
// sign in unchanged, and writes new hashes as Argon2id. A successful legacy verification reports needsRehash so the caller can
// upgrade the stored hash on login.
import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';

const PRF = { 0: 'sha1', 1: 'sha256', 2: 'sha512' };
const u32 = (b, o) => b.readUInt32BE(o);

export function verifyIdentityHash(stored, password) {
  let buf;
  try { buf = Buffer.from(stored, 'base64'); } catch { return false; }
  if (buf.length === 0) return false;
  let derived, expected;
  if (buf[0] === 0x01) { // v3: marker, prf, iterations, saltLen, salt, subkey
    if (buf.length < 13) return false;
    const prf = PRF[u32(buf, 1)]; const iter = u32(buf, 5); const saltLen = u32(buf, 9);
    if (!prf || iter < 1 || iter > 10_000_000 || saltLen < 16 || 13 + saltLen >= buf.length) return false;
    const salt = buf.subarray(13, 13 + saltLen); expected = buf.subarray(13 + saltLen);
    if (expected.length < 16) return false;
    derived = pbkdf2Sync(password, salt, iter, expected.length, prf);
  } else if (buf[0] === 0x00) { // v2: marker, salt(16), subkey(32); PBKDF2-HMAC-SHA1, 1000 iterations
    if (buf.length !== 49) return false;
    expected = buf.subarray(17); derived = pbkdf2Sync(password, buf.subarray(1, 17), 1000, 32, 'sha1');
  } else return false;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

let argon2Promise;
const loadArgon2 = () => (argon2Promise ??= import('argon2'));

export async function hashPassword(password) {
  const argon2 = await loadArgon2();
  return argon2.hash(password, { type: argon2.argon2id });
}

/** @returns {{ok:boolean, needsRehash:boolean}} */
export async function verifyPassword(stored, password) {
  if (!stored) return { ok: false, needsRehash: false };
  if (stored.startsWith('$argon2id$')) {
    const argon2 = await loadArgon2();
    let ok = false; try { ok = await argon2.verify(stored, password); } catch { ok = false; }
    return { ok, needsRehash: ok && argon2.needsRehash(stored) };
  }
  const ok = verifyIdentityHash(stored, password);
  return { ok, needsRehash: ok };
}

export const PASSWORD_MIN = 10; // Identity: RequiredLength = 10, no composition rules
export const PASSWORD_MAX = 128; // RegisterBusinessRequest / AcceptInvitationRequest StringLength(128)
