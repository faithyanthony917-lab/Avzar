import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { hashPassword, verifyPassword } from '../security/passwordHasher.js';
import { decide, nextIdleExpiry, RefreshDecision, tryParseToken } from '../security/sessionRules.js';
import { verifySecondFactor } from './accountService.js';
import { recordFailedAttempt } from '../security/accountLockout.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { useBusiness, withUserLookup } from '../db/userScope.js';

export const OWNER_PERMISSIONS = [
  'staff.view', 'staff.manage', 'roles.manage', 'locations.manage', 'locations.all', 'audit.view', 'business.settings',
  'customers.view', 'customers.manage', 'customers.merge', 'measurements.templates', 'measurements.record',
  'orders.view', 'orders.manage', 'orders.confirm', 'fittings.manage', 'tasks.view', 'tasks.manage', 'tasks.assign',
  'tasks.override', 'tasks.work', 'workflows.manage', 'workers.manage', 'designs.view', 'designs.manage', 'invoices.view',
  'invoices.manage', 'payments.view', 'payments.record', 'payments.verify', 'expenses.view', 'expenses.manage',
  'inventory.view', 'inventory.manage', 'reports.view', 'storefront.view', 'storefront.edit', 'storefront.publish',
  'inquiries.view', 'inquiries.manage', 'pricing.view', 'pricing.manage', 'media.view', 'media.manage',
  'documents.view', 'documents.manage',
];

const invalidCredentials = () => AppError.unauthorized('invalid_credentials', 'Email or password is incorrect.');
const invalidRefresh = () => AppError.unauthorized('invalid_refresh_token', 'The refresh token is invalid.');
const tokenHash = (secret) => createHash('sha256').update(secret).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');
const isSameHash = (left, right) => {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
const tokenFor = (sessionId, secret) => `${sessionId.replaceAll('-', '')}.${secret}`;

export async function currentUser(db, userId, businessId) {
  const { rows } = await db.query(`
    SELECT u."Id" AS "UserId", u."Email", u."FullName", b."Id" AS "BusinessId", b."Name" AS "BusinessName",
      b."TimeZoneId", b."CurrencyCode", m."IsOwner",
      COALESCE(array_agg(DISTINCT rp."Permission") FILTER (WHERE rp."Permission" IS NOT NULL), ARRAY[]::text[]) AS "Permissions"
    FROM "Memberships" m
    JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    JOIN "Businesses" b ON b."Id" = m."BusinessId"
    LEFT JOIN "MembershipRoles" mr ON mr."MembershipId" = m."Id" AND mr."BusinessId" = m."BusinessId"
    LEFT JOIN "RolePermissions" rp ON rp."RoleId" = mr."RoleId" AND rp."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0 AND b."IsActive" = TRUE
    GROUP BY u."Id", u."Email", u."FullName", b."Id", b."Name", b."TimeZoneId", b."CurrencyCode", m."IsOwner"`,
  [userId, businessId]);
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.UserId,
    email: row.Email,
    fullName: row.FullName,
    businessId: row.BusinessId,
    businessName: row.BusinessName,
    timeZoneId: row.TimeZoneId,
    currencyCode: row.CurrencyCode,
    isOwner: row.IsOwner,
    permissions: row.IsOwner ? [...OWNER_PERMISSIONS].sort() : row.Permissions.sort(),
  };
}

export async function authenticate(pool, request, env, now = new Date()) {
  const { rows } = await pool.query(`
    SELECT "Id", "Email", "FullName", "PasswordHash", "EmailConfirmed", "TwoFactorEnabled", "LockoutEnabled", "LockoutEnd"
    FROM "AspNetUsers" WHERE "NormalizedEmail" = $1 LIMIT 1`, [request.email.trim().toUpperCase()]);
  const user = rows[0];
  if (!user) throw invalidCredentials();
  if (user.LockoutEnabled && user.LockoutEnd && new Date(user.LockoutEnd) > now) {
    throw new AppError(423, 'locked_out', 'Too many failed attempts. Try again later.');
  }

  const password = await verifyPassword(user.PasswordHash, request.password);
  if (!password.ok) {
    await recordFailedAttempt(pool, user.Id, now);
    throw invalidCredentials();
  }
  if (env.REQUIRE_VERIFIED_EMAIL && !user.EmailConfirmed) {
    throw AppError.forbidden('email_not_verified', 'Confirm your email address first. Check your inbox for the link.');
  }
  if (user.TwoFactorEnabled) {
    if (!request.twoFactorCode && !request.recoveryCode) {
      throw AppError.unauthorized('two_factor_required', 'Enter the code from your authenticator app.');
    }
    if (!(await verifySecondFactor(pool, user.Id, request.twoFactorCode, request.recoveryCode))) {
      await recordFailedAttempt(pool, user.Id, now);
      throw AppError.unauthorized('invalid_two_factor_code', 'That code is not correct.');
    }
  }

  const updatedHash = password.needsRehash ? await hashPassword(request.password) : user.PasswordHash;
  await pool.query(`UPDATE "AspNetUsers" SET "AccessFailedCount" = 0, "PasswordHash" = $1, "ConcurrencyStamp" = $2 WHERE "Id" = $3`,
    [updatedHash, randomUUID(), user.Id]);

  // Credentials (and the second factor) are verified, so this user's own memberships may be read across businesses.
  const choicesResult = await withUserLookup(pool, user.Id, () => pool.query(`
    SELECT b."Id" AS "BusinessId", b."Name" AS "BusinessName"
    FROM "Memberships" m JOIN "Businesses" b ON b."Id" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."Status" = 0 AND b."IsActive" = TRUE ORDER BY b."Name"`, [user.Id]));
  const choices = choicesResult.rows.map((row) => ({ businessId: row.BusinessId, businessName: row.BusinessName }));
  if (choices.length === 0) throw AppError.forbidden('no_active_membership', 'This account has no active business membership.');
  if (request.businessId) {
    if (!choices.some((choice) => choice.businessId === request.businessId)) {
      throw AppError.forbidden('not_a_member', 'You are not an active member of that business.');
    }
    return { userId: user.Id, businessId: request.businessId, choices };
  }
  if (choices.length > 1) return { userId: user.Id, businessId: null, choices };
  return { userId: user.Id, businessId: choices[0].businessId, choices };
}

export async function createMobileSession(pool, userId, businessId, deviceName, env, now = new Date()) {
  // The business was chosen from the user's verified memberships; it is the tenant for the session rows and the rest of the request.
  useBusiness(pool, businessId);
  const client = await pool.connect();
  const sessionId = randomUUID();
  const secret = newSecret();
  const absoluteExpiry = new Date(now.getTime() + env.REFRESH_ABSOLUTE_DAYS * 86_400_000);
  const idleExpiry = nextIdleExpiry(now, env.REFRESH_IDLE_DAYS * 86_400_000, absoluteExpiry);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
    if (!await currentUser(client, userId, businessId)) {
      throw AppError.forbidden('not_a_member', 'You are not an active member of that business.');
    }
    const { rows } = await client.query(`
      SELECT "Id" FROM "UserSessions"
      WHERE "UserId" = $1 AND "DeviceName" <> 'Browser' AND "RevokedAtUtc" IS NULL AND "AbsoluteExpiresAtUtc" > $2 AND "IdleExpiresAtUtc" > $2
      ORDER BY "LastUsedAtUtc" FOR UPDATE`, [userId, now]);
    const revokeCount = Math.max(0, rows.length - (env.MAX_SESSIONS_PER_USER - 1));
    if (revokeCount) {
      await client.query(`UPDATE "UserSessions" SET "RevokedAtUtc" = $1, "RevokedReason" = 'session_limit' WHERE "Id" = ANY($2::uuid[])`,
        [now, rows.slice(0, revokeCount).map((row) => row.Id)]);
    }
    await client.query(`
      INSERT INTO "UserSessions" ("Id", "UserId", "BusinessId", "DeviceName", "CurrentTokenHash", "LastUsedAtUtc", "IdleExpiresAtUtc", "AbsoluteExpiresAtUtc", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6)`,
    [sessionId, userId, businessId, (deviceName?.trim() || 'Unknown device').slice(0, 80), tokenHash(secret), now, idleExpiry, absoluteExpiry]);
    await client.query('COMMIT');
    return { sessionId, refreshToken: tokenFor(sessionId, secret), refreshExpiresAtUtc: idleExpiry };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function rotateMobileSession(pool, refreshToken, env, now = new Date()) {
  const parsed = tryParseToken(refreshToken);
  if (!parsed) throw invalidRefresh();
  const secretHash = tokenHash(parsed.secret);
  // The token names a session but no business: the hash of its secret lets only the session that holds it be read (as its current or
  // previous token), then that session's business becomes the tenant. The row is still checked below, so reuse is detected as before.
  await bindTenantByLookup(pool, 'session_token_hash', secretHash);
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM "UserSessions" WHERE "Id" = $1 FOR UPDATE', [parsed.sessionId]);
    const row = rows[0];
    if (!row) throw invalidRefresh();
    const decision = decide({
      currentTokenHash: row.CurrentTokenHash,
      previousTokenHash: row.PreviousTokenHash,
      revokedAtUtc: row.RevokedAtUtc,
      idleExpiresAtUtc: row.IdleExpiresAtUtc,
      absoluteExpiresAtUtc: row.AbsoluteExpiresAtUtc,
    }, secretHash, now);
    if (decision === RefreshDecision.ReuseDetected) {
      await client.query(`UPDATE "UserSessions" SET "RevokedAtUtc" = $1, "RevokedReason" = 'token_reuse' WHERE "Id" = $2 AND "RevokedAtUtc" IS NULL`, [now, row.Id]);
      await client.query('COMMIT');
      committed = true;
      throw AppError.unauthorized('token_reuse_detected', 'This session was ended because a token was used twice. Please sign in again.');
    }
    if (decision === RefreshDecision.Expired) {
      await client.query(`UPDATE "UserSessions" SET "RevokedAtUtc" = $1, "RevokedReason" = 'expired' WHERE "Id" = $2 AND "RevokedAtUtc" IS NULL`, [now, row.Id]);
      await client.query('COMMIT');
      committed = true;
      throw AppError.unauthorized('session_expired', 'Your session has expired. Please sign in again.');
    }
    if (decision !== RefreshDecision.Rotate) throw invalidRefresh();

    const user = await client.query('SELECT "LockoutEnabled", "LockoutEnd" FROM "AspNetUsers" WHERE "Id" = $1', [row.UserId]);
    const inactive = !user.rows[0] || (user.rows[0].LockoutEnabled && user.rows[0].LockoutEnd && new Date(user.rows[0].LockoutEnd) > now);
    const current = inactive ? null : await currentUser(client, row.UserId, row.BusinessId);
    if (!current) {
      await client.query(`UPDATE "UserSessions" SET "RevokedAtUtc" = $1, "RevokedReason" = 'account_inactive' WHERE "Id" = $2 AND "RevokedAtUtc" IS NULL`, [now, row.Id]);
      await client.query('COMMIT');
      committed = true;
      throw AppError.unauthorized('session_revoked', 'This session is no longer valid. Please sign in again.');
    }

    const secret = newSecret();
    const idleExpiry = nextIdleExpiry(now, env.REFRESH_IDLE_DAYS * 86_400_000, new Date(row.AbsoluteExpiresAtUtc));
    await client.query(`
      UPDATE "UserSessions" SET "PreviousTokenHash" = "CurrentTokenHash", "CurrentTokenHash" = $1,
        "LastUsedAtUtc" = $2, "IdleExpiresAtUtc" = $3 WHERE "Id" = $4`, [tokenHash(secret), now, idleExpiry, row.Id]);
    await client.query('COMMIT');
    committed = true;
    return { userId: row.UserId, businessId: row.BusinessId, sessionId: row.Id, refreshToken: tokenFor(row.Id, secret), refreshExpiresAtUtc: idleExpiry };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeMobileSession(pool, refreshToken, now = new Date()) {
  const parsed = tryParseToken(refreshToken);
  if (!parsed) return;
  await bindTenantByLookup(pool, 'session_token_hash', tokenHash(parsed.secret));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT "Id", "CurrentTokenHash", "PreviousTokenHash", "RevokedAtUtc" FROM "UserSessions" WHERE "Id" = $1 FOR UPDATE', [parsed.sessionId]);
    const row = rows[0];
    const hash = tokenHash(parsed.secret);
    if (row && !row.RevokedAtUtc && (isSameHash(row.CurrentTokenHash, hash) || isSameHash(row.PreviousTokenHash, hash))) {
      await client.query(`UPDATE "UserSessions" SET "RevokedAtUtc" = $1, "RevokedReason" = 'logout' WHERE "Id" = $2`, [now, row.Id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}