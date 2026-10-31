// Session rules: refresh-token rotation and reuse detection.
import { timingSafeEqual } from 'node:crypto';

export const RefreshDecision = Object.freeze({ Rotate: 'Rotate', ReuseDetected: 'ReuseDetected', Unknown: 'Unknown', Expired: 'Expired', Revoked: 'Revoked' });

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function decide(s, presentedHash, now = new Date()) {
  if (s.revokedAtUtc) return RefreshDecision.Revoked;
  if (s.previousTokenHash && same(s.previousTokenHash, presentedHash)) return RefreshDecision.ReuseDetected;
  if (!same(s.currentTokenHash, presentedHash)) return RefreshDecision.Unknown;
  if (now >= s.absoluteExpiresAtUtc || now >= s.idleExpiresAtUtc) return RefreshDecision.Expired;
  return RefreshDecision.Rotate;
}

export function nextIdleExpiry(now, idleMs, absoluteExpiry) {
  const next = new Date(now.getTime() + idleMs);
  return next > absoluteExpiry ? absoluteExpiry : next;
}

// Token format "{sessionId as 32 hex chars}.{secret}"
export function tryParseToken(token) {
  if (typeof token !== 'string' || !token || token.length > 200 || token.indexOf('.') !== 32) return null;
  const hex = token.slice(0, 32);
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const secret = token.slice(33);
  if (secret.length < 20) return null;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
  return { sessionId: id, secret };
}
