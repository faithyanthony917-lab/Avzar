// Account, session list/revoke, 2FA, password reset and account deletion.
import { randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { hashPassword, verifyPassword } from '../security/passwordHasher.js';
import { decodeBase32, findStep, newAuthenticatorKey } from '../security/totp.js';
import { runWithTenantPlatformScope } from '../db/tenantRlsContext.js';
import { assertNotLocked, recordFailedAttempt } from '../security/accountLockout.js';
import { forEachUserBusiness, withUserLookup } from '../db/userScope.js';
import {
  PURPOSE_CONFIRM_EMAIL, PURPOSE_RESET_PASSWORD, accountTokenKey, issueAccountToken, verifyAccountToken,
} from '../security/accountTokens.js';

const STORE = '[AspNetUserStore]';
const invalidToken = () => AppError.badRequest('invalid_token', 'This link is invalid or has expired.');
const opt = (env) => ({
  webBase: String(env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  product: env.PRODUCT_NAME ?? 'Avzar',
  verifyHours: env.EMAIL_VERIFICATION_HOURS ?? 24,
  resetMinutes: env.PASSWORD_RESET_MINUTES ?? 30,
  throttleSeconds: env.EMAIL_THROTTLE_SECONDS ?? 120,
});

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const USER_COLUMNS = `"Id","Email","FullName","EmailConfirmed","TwoFactorEnabled","PasswordHash","SecurityStamp","CreatedAtUtc",
  ("LockoutEnd" = 'infinity') AS "Deleted"`;

async function findUser(db, where, value) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM "AspNetUsers" WHERE ${where} LIMIT 1`, [value]);
  return rows[0] ?? null;
}
async function requireUser(db, userId) {
  const user = await findUser(db, '"Id" = $1', userId);
  if (!user || user.Deleted) throw AppError.unauthorized('unknown_user', 'Unknown user.');
  return user;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderMail({ subject, greeting, line, action, link, footer }) {
  const text = `${greeting}\n\n${line}\n\n${action}: ${link}\n\n${footer}`;
  const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(line)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p><p>${escapeHtml(footer)}</p>`;
  return { subject, text, html };
}

async function throttle(db, address, templateKey, seconds) {
  const { rows } = await db.query(
    `SELECT 1 FROM "EmailOutbox" WHERE "ToAddress" = $1 AND "TemplateKey" = $2 AND "CreatedAtUtc" > now() - ($3::int * interval '1 second') LIMIT 1`,
    [address, templateKey, Math.max(0, seconds)]);
  if (rows.length) throw new AppError(429, 'too_many_requests', 'An email was sent a moment ago. Please wait a couple of minutes and check your inbox.');
}

async function queueEmail(db, address, mail, templateKey) {
  await db.query(
    `INSERT INTO "EmailOutbox" ("Id","Attempts","CreatedAtUtc","HtmlBody","NextAttemptUtc","Status","Subject","TemplateKey","TextBody","ToAddress")
     VALUES ($1, 0, now(), $2, now(), 'Pending', $3, $4, $5, $6)`,
    [randomUUID(), mail.html, mail.subject, templateKey, mail.text, address]);
}

// Sessions are stored per business, so ending every session of a user means one UPDATE under each business the user belongs to.
async function revokeAllSessions(db, userId, reason) {
  await forEachUserBusiness(db, userId, (scoped) => scoped.query(
    `UPDATE "UserSessions" SET "RevokedAtUtc" = now(), "RevokedReason" = $2 WHERE "UserId" = $1 AND "RevokedAtUtc" IS NULL`, [userId, reason]));
}

async function recordAudit(db, businessId, userId, action) {
  if (!businessId) return; // audit rows are per business; account events attach to the business the caller is signed in to
  await db.query(
    `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","EntityId","EntityType") VALUES ($1,$2,$3,$4,now(),$5,'AppUser')`,
    [randomUUID(), action, userId, businessId, userId]);
}

async function getToken(db, userId, name) {
  const { rows } = await db.query(`SELECT "Value" FROM "AspNetUserTokens" WHERE "UserId" = $1 AND "LoginProvider" = $2 AND "Name" = $3`, [userId, STORE, name]);
  return rows[0]?.Value ?? null;
}
async function setToken(db, userId, name, value) {
  await db.query(
    `INSERT INTO "AspNetUserTokens" ("UserId","LoginProvider","Name","Value") VALUES ($1,$2,$3,$4)
     ON CONFLICT ("UserId","LoginProvider","Name") DO UPDATE SET "Value" = EXCLUDED."Value"`, [userId, STORE, name, value]);
}
const recoveryCount = async (db, userId) => {
  const value = await getToken(db, userId, 'RecoveryCodes');
  return value ? value.split(';').filter(Boolean).length : 0;
};

function newRecoveryCode() {
  const hex = randomBytes(5).toString('hex');
  return `${hex.slice(0, 5)}-${hex.slice(5)}`;
}

/** True when the code is valid AND its time step is newer than any step already used. One conditional UPDATE claims the step, so two
 *  parallel requests with the same code cannot both succeed. */
async function verifyTotp(db, userId, code, now = new Date()) {
  if (!code || !String(code).trim()) return false;
  const key = decodeBase32(await getToken(db, userId, 'AuthenticatorKey'));
  if (!key) return false;
  const step = findStep(key, String(code).replaceAll(' ', '').replaceAll('-', ''), now);
  if (step === null) return false;
  const { rowCount } = await db.query(`UPDATE "AspNetUsers" SET "LastTotpStep" = $2 WHERE "Id" = $1 AND ("LastTotpStep" IS NULL OR "LastTotpStep" < $2)`, [userId, step]);
  return rowCount === 1;
}

async function redeemRecoveryCode(db, userId, code) {
  const supplied = String(code).trim();
  // Atomic: the row is rewritten only if the code is still in the stored list, so a code cannot be spent twice.
  const { rows } = await db.query(`SELECT "Value" FROM "AspNetUserTokens" WHERE "UserId" = $1 AND "LoginProvider" = $2 AND "Name" = 'RecoveryCodes' FOR UPDATE`, [userId, STORE]);
  const codes = (rows[0]?.Value ?? '').split(';').filter(Boolean);
  if (!codes.includes(supplied)) return false;
  await setToken(db, userId, 'RecoveryCodes', codes.filter((c) => c !== supplied).join(';'));
  return true;
}

async function secondFactorOk(db, userId, code, recoveryCode) {
  if (code && String(code).trim()) return verifyTotp(db, userId, code);
  if (recoveryCode && String(recoveryCode).trim()) return withTransaction(db, (tx) => redeemRecoveryCode(tx, userId, recoveryCode));
  return false;
}

export const verifySecondFactor = secondFactorOk;

async function requirePasswordAndSecondFactor(db, user, password, code, recoveryCode) {
  await assertNotLocked(db, user.Id);
  const check = await verifyPassword(user.PasswordHash, password);
  if (!check.ok) {
    await recordFailedAttempt(db, user.Id);
    throw AppError.badRequest('wrong_password', 'The password is incorrect.');
  }
  if (user.TwoFactorEnabled && !(await secondFactorOk(db, user.Id, code, recoveryCode))) {
    await recordFailedAttempt(db, user.Id);
    throw AppError.badRequest('invalid_code', 'The authentication code is not correct.');
  }
}

// ---------- email verification ----------

async function queueVerification(db, env, user) {
  const o = opt(env);
  const key = accountTokenKey(env);
  if (!key) throw new AppError(503, 'account_tokens_not_configured', 'Account links are not configured on this server.');
  await throttle(db, user.Email, 'verify_email', o.throttleSeconds);
  const token = issueAccountToken(key, user, PURPOSE_CONFIRM_EMAIL, o.verifyHours * 3600);
  const link = `${o.webBase}/verify-email?userId=${user.Id}&token=${encodeURIComponent(token)}`;
  await queueEmail(db, user.Email, renderMail({
    subject: 'Confirm your email address', greeting: `Hello ${user.FullName},`,
    line: `Please confirm your email address to finish setting up your account. The link is valid for ${o.verifyHours} hours.`,
    action: 'Confirm email', link, footer: 'If you did not create an account, you can ignore this email.',
  }), 'verify_email');
}

// Account mails belong to no business. Platform scope lets this request read and write EmailOutbox rows with a NULL BusinessId, nothing else.
export async function sendEmailVerification(pool, env, userId) {
  return runWithTenantPlatformScope(async () => {
    const user = await requireUser(pool, userId);
    if (user.EmailConfirmed) throw AppError.conflict('email_already_confirmed', 'This email address is already confirmed.');
    await queueVerification(pool, env, user);
  });
}

export async function confirmEmail(pool, env, { userId, token }) {
  const user = await findUser(pool, '"Id" = $1', userId);
  if (!user || user.Deleted || !verifyAccountToken(accountTokenKey(env), user, PURPOSE_CONFIRM_EMAIL, token)) throw invalidToken();
  await pool.query('UPDATE "AspNetUsers" SET "EmailConfirmed" = TRUE WHERE "Id" = $1', [user.Id]);
}

// ---------- password reset ----------

export function requestPasswordReset(pool, env, emailAddress) {
  return runWithTenantPlatformScope(() => requestPasswordResetInScope(pool, env, emailAddress));
}

async function requestPasswordResetInScope(pool, env, emailAddress) {
  const user = await findUser(pool, '"NormalizedEmail" = $1', emailAddress.trim().toUpperCase());
  if (!user || user.Deleted) return; // unknown or deleted: indistinguishable to the caller
  const key = accountTokenKey(env);
  if (!key) return;
  const o = opt(env);
  try { await throttle(pool, user.Email, 'password_reset', o.throttleSeconds); } catch (error) { if (error.status === 429) return; throw error; }
  const token = issueAccountToken(key, user, PURPOSE_RESET_PASSWORD, o.resetMinutes * 60);
  const link = `${o.webBase}/reset-password?userId=${user.Id}&token=${encodeURIComponent(token)}`;
  await queueEmail(pool, user.Email, renderMail({
    subject: 'Reset your password', greeting: `Hello ${user.FullName},`,
    line: `We received a request to reset your password. The link is valid for ${o.resetMinutes} minutes and works once.`,
    action: 'Choose a new password', link, footer: 'If you did not ask for this, ignore this email; your password will not change.',
  }), 'password_reset');
}

export async function resetPassword(pool, env, { userId, token, newPassword }) {
  const user = await findUser(pool, '"Id" = $1', userId);
  if (!user || user.Deleted || !verifyAccountToken(accountTokenKey(env), user, PURPOSE_RESET_PASSWORD, token)) throw invalidToken();
  const hash = await hashPassword(newPassword);
  await withTransaction(pool, async (tx) => {
    // Guarded by the old hash: two parallel uses of one link cannot both succeed.
    const { rowCount } = await tx.query(
      `UPDATE "AspNetUsers" SET "PasswordHash" = $2, "SecurityStamp" = $3, "AccessFailedCount" = 0, "LockoutEnd" = NULL
       WHERE "Id" = $1 AND "PasswordHash" IS NOT DISTINCT FROM $4`, [user.Id, hash, randomUUID(), user.PasswordHash]);
    if (rowCount !== 1) throw invalidToken();
    await revokeAllSessions(tx, user.Id, 'password_reset');
  });
}

export async function changePassword(pool, userId, businessId, { currentPassword, newPassword }) {
  const user = await requireUser(pool, userId);
  await assertNotLocked(pool, userId);
  if (!(await verifyPassword(user.PasswordHash, currentPassword)).ok) {
    await recordFailedAttempt(pool, userId);
    throw AppError.badRequest('wrong_password', 'The current password is incorrect.');
  }
  const hash = await hashPassword(newPassword);
  await withTransaction(pool, async (tx) => {
    await tx.query('UPDATE "AspNetUsers" SET "PasswordHash" = $2, "SecurityStamp" = $3 WHERE "Id" = $1', [userId, hash, randomUUID()]);
    await revokeAllSessions(tx, userId, 'password_changed');
    await recordAudit(tx, businessId, userId, 'account.password_changed');
  });
}

// ---------- profile ----------

export async function getProfile(db, userId) {
  const user = await requireUser(db, userId);
  const { rows } = await db.query('SELECT "PhoneNumber" FROM "AspNetUsers" WHERE "Id" = $1', [userId]);
  return { fullName: user.FullName, email: user.Email, phone: rows[0]?.PhoneNumber ?? null };
}

/** Changes only the signed-in person's own name and phone. Email changes need their own verification flow and are not done here. */
export async function updateProfile(pool, userId, businessId, { fullName, phone }) {
  await requireUser(pool, userId);
  const name = fullName.trim();
  const number = phone?.trim() || null;
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE "AspNetUsers" SET "FullName" = $2, "PhoneNumber" = $3,
         "PhoneNumberConfirmed" = CASE WHEN "PhoneNumber" IS NOT DISTINCT FROM $3 THEN "PhoneNumberConfirmed" ELSE FALSE END
       WHERE "Id" = $1 RETURNING "FullName", "Email", "PhoneNumber"`,
      [userId, name, number]);
    await recordAudit(tx, businessId, userId, 'account.profile_updated');
    const row = rows[0];
    return { fullName: row.FullName, email: row.Email, phone: row.PhoneNumber ?? null };
  });
}

// ---------- security overview and two-factor ----------

export async function listSessions(db, userId) {
  const perBusiness = await forEachUserBusiness(db, userId, (scoped) => scoped.query(`
    SELECT "Id","DeviceName","CreatedAtUtc","LastUsedAtUtc","IdleExpiresAtUtc" FROM "UserSessions"
    WHERE "UserId" = $1 AND "DeviceName" <> 'Browser' AND "RevokedAtUtc" IS NULL AND "AbsoluteExpiresAtUtc" > now() AND "IdleExpiresAtUtc" > now()
    ORDER BY "LastUsedAtUtc" DESC`, [userId]));
  const rows = perBusiness.flatMap((result) => result.rows);
  if (perBusiness.length > 1) rows.sort((a, b) => new Date(b.LastUsedAtUtc) - new Date(a.LastUsedAtUtc));
  return rows.map((r) => ({ id: r.Id, deviceName: r.DeviceName, createdAtUtc: r.CreatedAtUtc, lastUsedAtUtc: r.LastUsedAtUtc, expiresAtUtc: r.IdleExpiresAtUtc }));
}

export async function getSecurity(pool, userId) {
  const user = await requireUser(pool, userId);
  return {
    emailConfirmed: user.EmailConfirmed,
    twoFactorEnabled: user.TwoFactorEnabled,
    recoveryCodesLeft: user.TwoFactorEnabled ? await recoveryCount(pool, userId) : 0,
    activeSessions: (await listSessions(pool, userId)).length,
  };
}

export async function beginTwoFactorSetup(pool, env, userId) {
  const user = await requireUser(pool, userId);
  if (user.TwoFactorEnabled) throw AppError.conflict('two_factor_already_enabled', 'Two-factor authentication is already on.');
  let key = await getToken(pool, userId, 'AuthenticatorKey');
  if (!key) { key = newAuthenticatorKey(); await setToken(pool, userId, 'AuthenticatorKey', key); }
  const issuer = encodeURIComponent(opt(env).product);
  const label = encodeURIComponent(user.Email);
  return { sharedKey: key, otpAuthUri: `otpauth://totp/${issuer}:${label}?secret=${key}&issuer=${issuer}&digits=6` };
}

export async function enableTwoFactor(pool, userId, businessId, { code }) {
  const user = await requireUser(pool, userId);
  if (user.TwoFactorEnabled) throw AppError.conflict('two_factor_already_enabled', 'Two-factor authentication is already on.');
  if (!(await getToken(pool, userId, 'AuthenticatorKey'))) throw AppError.badRequest('two_factor_not_started', 'Start two-factor setup first.');
  if (!(await verifyTotp(pool, userId, code))) throw AppError.badRequest('invalid_code', 'That code is not correct. Check the time on your phone and try again.');
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  await withTransaction(pool, async (tx) => {
    await tx.query('UPDATE "AspNetUsers" SET "TwoFactorEnabled" = TRUE WHERE "Id" = $1', [userId]);
    await setToken(tx, userId, 'RecoveryCodes', codes.join(';'));
    await recordAudit(tx, businessId, userId, 'account.two_factor_enabled');
  });
  return { codes };
}

export async function disableTwoFactor(pool, userId, businessId, { password, code, recoveryCode }) {
  const user = await requireUser(pool, userId);
  if (!user.TwoFactorEnabled) throw AppError.conflict('two_factor_not_enabled', 'Two-factor authentication is not on.');
  await requirePasswordAndSecondFactor(pool, user, password, code, recoveryCode);
  await withTransaction(pool, async (tx) => {
    await tx.query('UPDATE "AspNetUsers" SET "TwoFactorEnabled" = FALSE, "LastTotpStep" = NULL WHERE "Id" = $1', [userId]);
    await setToken(tx, userId, 'AuthenticatorKey', newAuthenticatorKey()); // the old secret must stop working
    await setToken(tx, userId, 'RecoveryCodes', '');
    await recordAudit(tx, businessId, userId, 'account.two_factor_disabled');
  });
}

// ---------- sessions ----------

export async function revokeSessionById(pool, userId, sessionId) {
  // Another user's session id behaves exactly like a missing one.
  // The session may belong to any business the user is in, so look under each one.
  let found = false;
  await forEachUserBusiness(pool, userId, async (scoped) => {
    const { rows } = await scoped.query('SELECT "RevokedAtUtc" FROM "UserSessions" WHERE "Id" = $1 AND "UserId" = $2', [sessionId, userId]);
    if (!rows.length) return;
    found = true;
    await scoped.query(`UPDATE "UserSessions" SET "RevokedAtUtc" = now(), "RevokedReason" = 'revoked_by_user' WHERE "Id" = $1 AND "UserId" = $2 AND "RevokedAtUtc" IS NULL`, [sessionId, userId]);
  });
  if (!found) throw AppError.notFound('session_not_found', 'Session not found.');
}
export const revokeAllSessionsForUser = (pool, userId) => revokeAllSessions(pool, userId, 'revoked_by_user');

// ---------- export and deletion ----------

export async function exportAccount(pool, userId) {
  const user = await requireUser(pool, userId);
  // Roles live in tables isolated per business, so each business's memberships are read under that business's context.
  const perBusiness = await forEachUserBusiness(pool, userId, (scoped, businessId) => scoped.query(`
    SELECT m."Id" AS "MembershipId", b."Id" AS "BusinessId", b."Name", m."DisplayName", m."IsOwner", m."Status",
           COALESCE(array_agg(r."Name" ORDER BY r."Name") FILTER (WHERE r."Id" IS NOT NULL), ARRAY[]::text[]) AS "Roles"
    FROM "Memberships" m
    JOIN "Businesses" b ON b."Id" = m."BusinessId"
    LEFT JOIN "MembershipRoles" mr ON mr."MembershipId" = m."Id" AND mr."BusinessId" = m."BusinessId"
    LEFT JOIN "BusinessRoles" r ON r."Id" = mr."RoleId" AND r."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1${businessId ? ' AND m."BusinessId" = $2' : ''}
    GROUP BY m."Id", b."Id", b."Name", m."DisplayName", m."IsOwner", m."Status"`, businessId ? [userId, businessId] : [userId]));
  const rows = perBusiness.flatMap((result) => result.rows);
  return {
    userId: user.Id, email: user.Email, fullName: user.FullName, emailConfirmed: user.EmailConfirmed,
    twoFactorEnabled: user.TwoFactorEnabled, createdAtUtc: user.CreatedAtUtc,
    memberships: rows.map((r) => ({ businessId: r.BusinessId, businessName: r.Name, displayName: r.DisplayName, isOwner: r.IsOwner, status: r.Status === 0 ? 'Active' : 'Deactivated', roles: r.Roles })),
    sessions: await listSessions(pool, userId),
    exportedAtUtc: new Date().toISOString(),
  };
}

export async function deleteAccount(pool, userId, businessId, { password, twoFactorCode, recoveryCode }) {
  const user = await requireUser(pool, userId);
  await requirePasswordAndSecondFactor(pool, user, password, twoFactorCode, recoveryCode);
  const { rows } = await withUserLookup(pool, userId, () => pool.query('SELECT 1 FROM "Memberships" WHERE "UserId" = $1 AND "IsOwner" AND "Status" = 0 LIMIT 1', [userId]));
  if (rows.length) throw AppError.conflict('owner_of_business', 'You own a business. Close the business or hand it over before deleting your account.');
  const anon = `deleted-${userId.replaceAll('-', '')}@deleted.invalid`;
  await withTransaction(pool, async (tx) => {
    await recordAudit(tx, businessId, userId, 'account.deleted');
    // Financial and audit records stay (they reference the user id); the person behind them is anonymised.
    await forEachUserBusiness(tx, userId, (scoped) => scoped.query(`UPDATE "Memberships" SET "Status" = 1, "DeactivatedAtUtc" = now(), "DisplayName" = 'Deleted user' WHERE "UserId" = $1`, [userId]));
    await tx.query(
      `UPDATE "AspNetUsers" SET "FullName" = 'Deleted user', "PhoneNumber" = NULL, "UserName" = $2::text, "NormalizedUserName" = upper($2::text),
         "Email" = $2::text, "NormalizedEmail" = upper($2::text), "PasswordHash" = NULL, "TwoFactorEnabled" = FALSE, "LastTotpStep" = NULL,
         "LockoutEnabled" = TRUE, "LockoutEnd" = 'infinity', "SecurityStamp" = $3 WHERE "Id" = $1`, [userId, anon, randomUUID()]);
    await tx.query(`DELETE FROM "AspNetUserTokens" WHERE "UserId" = $1 AND "LoginProvider" = $2 AND "Name" IN ('AuthenticatorKey','RecoveryCodes')`, [userId, STORE]);
    await revokeAllSessions(tx, userId, 'account_deleted');
  });
}
