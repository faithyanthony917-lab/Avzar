import { AppError } from '../http/errors.js';

// One lockout rule for every place that checks a password: 5 wrong attempts lock the account for 15 minutes.
// A deleted account carries LockoutEnd = 'infinity'; nothing here may ever overwrite that.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

const lockedOut = () => new AppError(423, 'locked_out', 'Too many failed attempts. Try again later.');
// The pg driver returns the deleted-account marker 'infinity' as the number Infinity, which `new Date()` cannot read.
const endMs = (value) => (value === Infinity ? Infinity : new Date(value).getTime());
const isLocked = (row, now) => Boolean(row?.LockoutEnabled && row.LockoutEnd && endMs(row.LockoutEnd) > now.getTime());

/** Throws 423 while the account is locked. Call before checking a password. */
export async function assertNotLocked(db, userId, now = new Date()) {
  const { rows } = await db.query('SELECT "LockoutEnabled", "LockoutEnd" FROM "AspNetUsers" WHERE "Id" = $1', [userId]);
  if (isLocked(rows[0], now)) throw lockedOut();
}

/**
 * Counts one wrong password or code. A count left over from a lockout that has already ended starts again at 1,
 * so one wrong attempt after the lock ends no longer locks the account again at once.
 * Throws 423 when this attempt locks the account; otherwise returns and the caller throws its own error.
 */
export async function recordFailedAttempt(db, userId, now = new Date()) {
  const lockUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60_000);
  const { rows } = await db.query(`
    WITH prior AS (
      SELECT "Id", CASE WHEN "LockoutEnd" IS NOT NULL AND "LockoutEnd" <= $1 THEN 0 ELSE "AccessFailedCount" END AS "Base"
      FROM "AspNetUsers" WHERE "Id" = $3 FOR UPDATE)
    UPDATE "AspNetUsers" u SET
      "AccessFailedCount" = prior."Base" + 1,
      "LockoutEnd" = CASE
        WHEN u."LockoutEnd" = 'infinity' THEN u."LockoutEnd"
        WHEN u."LockoutEnabled" AND prior."Base" + 1 >= $4 THEN $2
        WHEN u."LockoutEnd" IS NOT NULL AND u."LockoutEnd" <= $1 THEN NULL
        ELSE u."LockoutEnd" END
    FROM prior WHERE u."Id" = prior."Id"
    RETURNING u."LockoutEnabled", u."LockoutEnd"`, [now, lockUntil, userId, MAX_FAILED_ATTEMPTS]);
  if (isLocked(rows[0], now)) throw lockedOut();
}
