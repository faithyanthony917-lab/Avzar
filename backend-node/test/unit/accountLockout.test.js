import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotLocked, recordFailedAttempt, LOCKOUT_MINUTES, MAX_FAILED_ATTEMPTS } from '../../src/security/accountLockout.js';

const now = new Date('2026-11-01T10:00:00Z');
const later = (minutes) => new Date(now.getTime() + minutes * 60_000);
const dbReturning = (row) => { const calls = []; return { calls, query: async (sql, values) => { calls.push({ sql, values }); return { rows: row ? [row] : [] }; } }; };

describe('account lockout helper', () => {
  it('uses 5 attempts and 15 minutes', () => {
    assert.equal(MAX_FAILED_ATTEMPTS, 5);
    assert.equal(LOCKOUT_MINUTES, 15);
  });
  it('refuses a locked account with 423 and lets an unlocked or expired one through', async () => {
    await assert.rejects(assertNotLocked(dbReturning({ LockoutEnabled: true, LockoutEnd: later(5) }), 'u1', now), (e) => e.status === 423 && e.code === 'locked_out');
    await assertNotLocked(dbReturning({ LockoutEnabled: true, LockoutEnd: later(-1) }), 'u1', now);
    await assertNotLocked(dbReturning({ LockoutEnabled: true, LockoutEnd: null }), 'u1', now);
    await assertNotLocked(dbReturning({ LockoutEnabled: false, LockoutEnd: later(5) }), 'u1', now);
    await assertNotLocked(dbReturning(null), 'u1', now);
  });
  it('passes the time, the lock end, the user and the limit, and throws 423 only when the row comes back locked', async () => {
    const db = dbReturning({ LockoutEnabled: true, LockoutEnd: null });
    await recordFailedAttempt(db, 'u1', now);
    assert.deepEqual(db.calls[0].values, [now, later(15), 'u1', 5]);
    const locked = dbReturning({ LockoutEnabled: true, LockoutEnd: later(15) });
    await assert.rejects(recordFailedAttempt(locked, 'u1', now), (e) => e.status === 423);
    await recordFailedAttempt(dbReturning(null), 'u1', now);
  });
  it('writes SQL that restarts the count after an ended lockout and never overwrites a deleted account', async () => {
    const db = dbReturning(null);
    await recordFailedAttempt(db, 'u1', now);
    const sql = db.calls[0].sql;
    assert.match(sql, /"LockoutEnd" <= \$1 THEN 0 ELSE "AccessFailedCount"/);
    assert.match(sql, /WHEN u\."LockoutEnd" = 'infinity' THEN u\."LockoutEnd"/);
    assert.match(sql, /FOR UPDATE/);
  });
});

describe('account lockout helper: deleted accounts', () => {
  it('treats the pg value Infinity (the deleted-account marker) as locked', async () => {
    await assert.rejects(assertNotLocked(dbReturning({ LockoutEnabled: true, LockoutEnd: Infinity }), 'u1', now), (e) => e.status === 423);
    await assert.rejects(recordFailedAttempt(dbReturning({ LockoutEnabled: true, LockoutEnd: Infinity }), 'u1', now), (e) => e.status === 423);
  });
});
