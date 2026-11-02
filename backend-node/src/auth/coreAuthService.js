import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { hashPassword } from '../security/passwordHasher.js';
import { newCsrfToken } from '../security/csrf.js';
import { withTransaction } from './accountService.js';
import { OWNER_PERMISSIONS, authenticate, createMobileSession, currentUser } from './mobileAuthService.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { runWithTenantRlsContext } from '../db/tenantRlsContext.js';
import { useBusiness, withUserLookup } from '../db/userScope.js';

const normalizeEmail = (email) => email.trim().toUpperCase();
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const accountantPermissions = [
  'orders.view', 'customers.view', 'invoices.view', 'invoices.manage', 'payments.view', 'payments.record',
  'payments.verify', 'expenses.view', 'expenses.manage', 'reports.view', 'locations.all',
];
const defaultRoles = [
  { name: 'Owner', permissions: OWNER_PERMISSIONS },
  { name: 'Manager', permissions: OWNER_PERMISSIONS.filter((permission) => !['business.settings', 'roles.manage'].includes(permission)) },
  { name: 'Accountant', permissions: accountantPermissions },
  ...['Tailor', 'Cutter', 'Finisher', 'Quality Control'].map((name) => ({ name, permissions: ['tasks.work'] })),
];

const measurementTemplates = [
  ['Shirt', [['neck', 'Neck', true], ['chest', 'Chest', true], ['waist', 'Waist', false], ['shoulder', 'Shoulder', true], ['sleeve_length', 'Sleeve length', true], ['shirt_length', 'Shirt length', true], ['bicep', 'Bicep', false], ['wrist', 'Wrist', false]]],
  ['Trousers', [['waist', 'Waist', true], ['hips', 'Hips', true], ['rise', 'Rise', false], ['inseam', 'Inseam', true], ['outseam', 'Outseam', true], ['thigh', 'Thigh', false], ['knee', 'Knee', false], ['bottom_opening', 'Bottom opening', false]]],
  ['Jacket / Suit', [['chest', 'Chest', true], ['waist', 'Waist', true], ['hips', 'Hips', false], ['shoulder', 'Shoulder', true], ['sleeve_length', 'Sleeve length', true], ['jacket_length', 'Jacket length', true], ['back_width', 'Back width', false], ['bicep', 'Bicep', false]]],
  ['Dress / Gown', [['bust', 'Bust', true], ['waist', 'Waist', true], ['hips', 'Hips', true], ['shoulder', 'Shoulder', false], ['shoulder_to_waist', 'Shoulder to waist', false], ['dress_length', 'Dress length', true], ['sleeve_length', 'Sleeve length', false]]],
  ['Skirt', [['waist', 'Waist', true], ['hips', 'Hips', true], ['skirt_length', 'Skirt length', true]]],
  ['Native attire', [['chest', 'Chest', true], ['waist', 'Waist', false], ['hips', 'Hips', false], ['shoulder', 'Shoulder', true], ['sleeve_length', 'Sleeve length', false], ['top_length', 'Top length', true], ['trouser_waist', 'Trouser waist', false], ['trouser_length', 'Trouser length', false]]],
];

const workflowStages = [
  { key: 'measurements_verified', name: 'Measurements Verified', minutes: 15, skill: null, checks: ['Measurements match the order snapshot'], instructions: "Compare the order's measurement snapshot with the customer's request." },
  { key: 'materials_prepared', name: 'Materials Prepared', minutes: 30, skill: null, checks: ['Fabric and trims set aside', 'Quantities checked'] },
  { key: 'cutting', name: 'Cutting', minutes: 60, skill: 'cutting', checks: ['Pattern pieces counted'] },
  { key: 'sewing', name: 'Sewing', minutes: 120, skill: 'sewing', checks: [] },
  { key: 'finishing', name: 'Finishing', minutes: 45, skill: 'finishing', checks: ['Loose threads trimmed', 'Pressed'] },
  { key: 'quality_control', name: 'Quality Control', minutes: 20, skill: 'quality control', checks: ['Seams and measurements inspected'] },
  { key: 'fitting', name: 'Fitting', minutes: 30, skill: null, checks: [] },
  { key: 'alterations', name: 'Alterations', minutes: 45, skill: 'sewing', checks: [], conditional: true },
  { key: 'final_quality_check', name: 'Final Quality Check', minutes: 20, skill: 'quality control', checks: ['Final inspection passed'] },
  { key: 'ready_for_collection', name: 'Ready for Collection', minutes: 10, skill: null, checks: ['Garment packaged and labelled'] },
];
const stageDependencies = [
  ['materials_prepared', 'measurements_verified'], ['cutting', 'materials_prepared'], ['sewing', 'cutting'],
  ['finishing', 'sewing'], ['quality_control', 'finishing'], ['fitting', 'quality_control'],
  ['alterations', 'fitting'], ['final_quality_check', 'fitting'], ['final_quality_check', 'alterations'],
  ['ready_for_collection', 'final_quality_check'],
];

async function recordAudit(db, businessId, actorId, action, entityType, entityId) {
  await db.query(
    `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","EntityId","EntityType")
     VALUES ($1,$2,$3,$4,now(),$5,$6)`, [randomUUID(), action, actorId, businessId, entityId, entityType]);
}

function validateBusinessValues(request) {
  const currencyCode = request.currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw AppError.badRequest('invalid_currency', 'Currency must be a 3-letter ISO 4217 code.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: request.timeZoneId }).format(); }
  catch { throw AppError.badRequest('invalid_time_zone', 'Unknown time zone id.'); }
  return currencyCode;
}

export async function createCsrfToken(secret) {
  return newCsrfToken(secret);
}

export async function authenticateUser(pool, request, env) {
  return authenticate(pool, request, env);
}

export async function getCurrentUser(pool, userId, businessId) {
  return currentUser(pool, userId, businessId);
}

export async function registerBusiness(pool, request, env) {
  const email = request.email.trim();
  const normalizedEmail = normalizeEmail(email);
  const fullName = request.ownerName.trim();
  const businessName = request.businessName.trim();
  const currencyCode = validateBusinessValues(request);
  const passwordHash = await hashPassword(request.password);
  const userId = randomUUID();
  const businessId = randomUUID();
  const locationId = randomUUID();
  const membershipId = randomUUID();
  const securityStamp = randomUUID();

  // This request creates the business, so its new ID is the tenant before any tenant row is written. A business ID nobody else
  // can name has no existing rows to expose.
  useBusiness(pool, businessId);
  await withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [normalizedEmail]);
    const existing = await db.query('SELECT 1 FROM "AspNetUsers" WHERE "NormalizedEmail" = $1 LIMIT 1', [normalizedEmail]);
    if (existing.rows.length) throw AppError.conflict('email_in_use', 'An account with this email already exists.');
    const plan = await db.query('SELECT "Id" FROM "Plans" WHERE "Code" = $1 AND "IsActive" = TRUE LIMIT 1', ['free']);
    if (!plan.rows.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');

    await db.query(
      `INSERT INTO "AspNetUsers" ("Id","AccessFailedCount","ConcurrencyStamp","CreatedAtUtc","Email","EmailConfirmed","FullName",
        "LockoutEnabled","NormalizedEmail","NormalizedUserName","PasswordHash","PhoneNumberConfirmed","SecurityStamp","TwoFactorEnabled","UserName")
       VALUES ($1,0,$2,now(),$3,FALSE,$4,TRUE,$5,$5,$6,FALSE,$2,FALSE,$3)`,
      [userId, securityStamp, email, fullName, normalizedEmail, passwordHash]);
    await db.query(
      `INSERT INTO "Businesses" ("Id","Name","TimeZoneId","CurrencyCode","IsActive","CreatedAtUtc") VALUES ($1,$2,$3,$4,TRUE,now())`,
      [businessId, businessName, request.timeZoneId, currencyCode]);
    await db.query(
      `INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,$3,TRUE,now())`,
      [locationId, businessId, request.locationName?.trim() || 'Main workshop']);

    const roleIds = new Map();
    for (const role of defaultRoles) {
      const roleId = randomUUID();
      roleIds.set(role.name, roleId);
      await db.query(
        `INSERT INTO "BusinessRoles" ("Id","BusinessId","Name","IsSystem","CreatedAtUtc") VALUES ($1,$2,$3,TRUE,now())`,
        [roleId, businessId, role.name]);
      if (role.permissions.length) {
        await db.query(
          `INSERT INTO "RolePermissions" ("RoleId","Permission","BusinessId") SELECT $1,permission,$2 FROM unnest($3::text[]) AS permissions(permission)`,
          [roleId, businessId, role.permissions]);
      }
    }

    await db.query(
      `INSERT INTO "Memberships" ("Id","BusinessId","UserId","DisplayName","IsOwner","Status","CreatedAtUtc") VALUES ($1,$2,$3,$4,TRUE,0,now())`,
      [membershipId, businessId, userId, fullName]);
    await db.query('INSERT INTO "MembershipRoles" ("MembershipId","RoleId","BusinessId") VALUES ($1,$2,$3)', [membershipId, roleIds.get('Owner'), businessId]);
    await db.query('INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)', [membershipId, locationId, businessId]);

    for (const [name, fields] of measurementTemplates) {
      const templateId = randomUUID();
      await db.query(
        `INSERT INTO "MeasurementTemplates" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,$3,TRUE,now())`,
        [templateId, businessId, name]);
      for (let sortOrder = 0; sortOrder < fields.length; sortOrder += 1) {
        const [key, label, required] = fields[sortOrder];
        await db.query(
          `INSERT INTO "MeasurementTemplateFields" ("Id","BusinessId","TemplateId","Key","Label","Unit","MinValue","MaxValue","IsRequired","SortOrder","CreatedAtUtc")
           VALUES ($1,$2,$3,$4,$5,'cm',1,300,$6,$7,now())`,
          [randomUUID(), businessId, templateId, key, label, required, sortOrder]);
      }
    }

    const workflowId = randomUUID();
    await db.query(
      `INSERT INTO "Workflows" ("Id","BusinessId","Name","Description","IsDefault","IsActive","GarmentCategories","CreatedAtUtc")
       VALUES ($1,$2,'Standard garment','Default made-to-measure flow. Edit or duplicate it for your own process.',TRUE,TRUE,'{}'::text[],now())`,
      [workflowId, businessId]);
    const stageIds = new Map();
    for (let sortOrder = 0; sortOrder < workflowStages.length; sortOrder += 1) {
      const stage = workflowStages[sortOrder];
      const stageId = randomUUID();
      stageIds.set(stage.key, stageId);
      await db.query(
        `INSERT INTO "Stages" ("Id","BusinessId","WorkflowId","Key","Name","SortOrder","DefaultMinutes","RequiredSkill","CompletionChecks","IsConditional","Instructions","RequiresApproval","CreatedAtUtc")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,FALSE,now())`,
        [stageId, businessId, workflowId, stage.key, stage.name, sortOrder, stage.minutes, stage.skill ?? null, stage.checks, stage.conditional ?? false, stage.instructions ?? null]);
    }
    for (const [stageKey, dependencyKey] of stageDependencies) {
      await db.query(
        'INSERT INTO "StageDependencies" ("StageId","DependsOnStageId","BusinessId") VALUES ($1,$2,$3)',
        [stageIds.get(stageKey), stageIds.get(dependencyKey), businessId]);
    }

    await db.query(
      `INSERT INTO "Subscriptions" ("Id","BusinessId","PlanId","Status","CurrentPeriodStartUtc","CreatedAtUtc")
       VALUES ($1,$2,$3,'Active',now(),now())`, [randomUUID(), businessId, plan.rows[0].Id]);
    await recordAudit(db, businessId, userId, 'business.registered', 'Business', businessId);
  });

  try { await import('./accountService.js').then(({ sendEmailVerification }) => sendEmailVerification(pool, env, userId)); }
  catch (error) { if (error instanceof Error && error.name === 'AbortError') throw error; }
  return { userId, businessId };
}

async function findInvitation(db, rawToken) {
  const tokenHash = hashToken(rawToken.trim());
  const { rows } = await db.query(
    `SELECT "Id","BusinessId","Email","FullName","RoleIds","LocationIds" FROM "Invitations"
     WHERE "TokenHash" = $1 AND "AcceptedAtUtc" IS NULL AND "RevokedAtUtc" IS NULL AND "ExpiresAtUtc" > now() FOR UPDATE`,
    [tokenHash]);
  if (!rows.length) throw AppError.badRequest('invalid_invitation', 'This invitation is invalid or has expired.');
  return rows[0];
}

async function resolveInvitationAccess(db, invite) {
  const roles = await db.query(
    `SELECT "Id" FROM "BusinessRoles" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[]) AND "Name" <> 'Owner'`,
    [invite.BusinessId, invite.RoleIds]);
  if (!roles.rows.length) throw AppError.badRequest('invalid_invitation', 'The roles for this invitation no longer exist.');
  const locations = invite.LocationIds.length
    ? await db.query('SELECT "Id" FROM "Locations" WHERE "BusinessId" = $1 AND "IsActive" = TRUE AND "Id" = ANY($2::uuid[])', [invite.BusinessId, invite.LocationIds])
    : { rows: [] };
  return { roleIds: roles.rows.map((row) => row.Id), locationIds: locations.rows.map((row) => row.Id) };
}

async function ensureSeatAvailable(db, businessId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${businessId}:users.max`]);
  const { rows } = await db.query(`
    SELECT COALESCE(override."Value", pe."Value") AS "Value"
    FROM "Plans" p
    LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" AND pe."Key" = 'users.max'
    LEFT JOIN LATERAL (
      SELECT o."Value" FROM "EntitlementOverrides" o
      WHERE o."BusinessId" = $1 AND o."Key" = 'users.max' AND (o."ExpiresAtUtc" IS NULL OR o."ExpiresAtUtc" > now())
      ORDER BY o."CreatedAtUtc" DESC LIMIT 1
    ) override ON TRUE
    WHERE p."Id" = COALESCE(
      (SELECT s."PlanId" FROM "Subscriptions" s WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' AND free."IsActive" = TRUE LIMIT 1)
    )`, [businessId]);
  if (!rows.length || rows[0].Value == null) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');
  const limit = Number(rows[0].Value);
  if (!Number.isFinite(limit) || limit < 0) return;
  const used = await db.query('SELECT count(*)::int AS "Count" FROM "Memberships" WHERE "BusinessId" = $1 AND "Status" = 0', [businessId]);
  if (used.rows[0].Count >= limit) {
    throw AppError.forbidden('plan_limit_reached', `Your plan allows ${limit} users, and you have used ${used.rows[0].Count}. Upgrade your plan to add more. Nothing has been deleted.`,
      { entitlement: 'users.max', limit, used: used.rows[0].Count });
  }
}

async function createMembership(db, invite, userId, access) {
  const membershipId = randomUUID();
  await db.query(
    `INSERT INTO "Memberships" ("Id","BusinessId","UserId","DisplayName","IsOwner","Status","CreatedAtUtc") VALUES ($1,$2,$3,$4,FALSE,0,now())`,
    [membershipId, invite.BusinessId, userId, invite.FullName]);
  for (const roleId of access.roleIds) {
    await db.query('INSERT INTO "MembershipRoles" ("MembershipId","RoleId","BusinessId") VALUES ($1,$2,$3)', [membershipId, roleId, invite.BusinessId]);
  }
  for (const locationId of access.locationIds) {
    await db.query('INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)', [membershipId, locationId, invite.BusinessId]);
  }
  return membershipId;
}

export async function acceptInvitation(pool, request) {
  // The invitation token is the key: it makes only that invitation readable, then its business becomes the tenant.
  await bindTenantByLookup(pool, 'invitation_token_hash', hashToken(String(request.token ?? '').trim()));
  return withTransaction(pool, async (db) => {
    const invite = await findInvitation(db, request.token);
    const normalizedEmail = normalizeEmail(invite.Email);
    const existing = await db.query('SELECT 1 FROM "AspNetUsers" WHERE "NormalizedEmail" = $1 LIMIT 1', [normalizedEmail]);
    if (existing.rows.length) throw AppError.conflict('account_exists', 'An account with this email already exists. Sign in, then accept the invitation from your account.');
    const access = await resolveInvitationAccess(db, invite);
    await ensureSeatAvailable(db, invite.BusinessId);
    const userId = randomUUID();
    const passwordHash = await hashPassword(request.password);
    const securityStamp = randomUUID();
    await db.query(
      `INSERT INTO "AspNetUsers" ("Id","AccessFailedCount","ConcurrencyStamp","CreatedAtUtc","Email","EmailConfirmed","FullName",
        "LockoutEnabled","NormalizedEmail","NormalizedUserName","PasswordHash","PhoneNumberConfirmed","SecurityStamp","TwoFactorEnabled","UserName")
       VALUES ($1,0,$2,now(),$3,TRUE,$4,TRUE,$5,$5,$6,FALSE,$2,FALSE,$3)`,
      [userId, securityStamp, invite.Email, invite.FullName, normalizedEmail, passwordHash]);
    const membershipId = await createMembership(db, invite, userId, access);
    await db.query('UPDATE "Invitations" SET "AcceptedAtUtc" = now() WHERE "Id" = $1 AND "AcceptedAtUtc" IS NULL', [invite.Id]);
    await recordAudit(db, invite.BusinessId, userId, 'staff.invitation_accepted', 'BusinessMembership', membershipId);
    return { userId, businessId: invite.BusinessId };
  }).catch((error) => {
    if (error?.code === '23505') throw AppError.conflict('already_member', 'You already belong to this business.');
    throw error;
  });
}

export async function acceptInvitationForExistingUser(pool, userId, request) {
  const user = await pool.query(`SELECT "Id","Email" FROM "AspNetUsers" WHERE "Id" = $1 AND "LockoutEnd" IS DISTINCT FROM 'infinity'::timestamptz`, [userId]);
  if (!user.rows.length) throw AppError.unauthorized('unknown_user', 'Unknown user.');
  await bindTenantByLookup(pool, 'invitation_token_hash', hashToken(String(request.token ?? '').trim()));
  return withTransaction(pool, async (db) => {
    const invite = await findInvitation(db, request.token);
    if (user.rows[0].Email?.toLowerCase() !== invite.Email.toLowerCase()) {
      throw AppError.forbidden('invitation_email_mismatch', "This invitation was sent to a different email address than your account's.");
    }
    const access = await resolveInvitationAccess(db, invite);
    const alreadyMember = await db.query('SELECT 1 FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 LIMIT 1', [invite.BusinessId, userId]);
    if (alreadyMember.rows.length) throw AppError.conflict('already_member', 'You already belong to this business.');
    await ensureSeatAvailable(db, invite.BusinessId);
    const membershipId = await createMembership(db, invite, userId, access);
    await db.query('UPDATE "Invitations" SET "AcceptedAtUtc" = now() WHERE "Id" = $1 AND "AcceptedAtUtc" IS NULL', [invite.Id]);
    await recordAudit(db, invite.BusinessId, userId, 'staff.invitation_accepted_existing_account', 'BusinessMembership', membershipId);
    return { userId, businessId: invite.BusinessId };
  }).catch((error) => {
    if (error?.code === '23505') throw AppError.conflict('already_member', 'You already belong to this business.');
    throw error;
  });
}

export async function createBrowserSession(pool, env, identity) {
  const sessionEnv = {
    ...env,
    REFRESH_IDLE_DAYS: env.REFRESH_IDLE_DAYS ?? 30,
    REFRESH_ABSOLUTE_DAYS: env.REFRESH_ABSOLUTE_DAYS ?? 90,
    MAX_SESSIONS_PER_USER: env.MAX_SESSIONS_PER_USER ?? 10,
  };
  const tokens = await createMobileSession(pool, identity.userId, identity.businessId, 'Browser', sessionEnv);
  const user = await currentUser(pool, identity.userId, identity.businessId);
  if (!user) throw AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.');
  return { ...tokens, user };
}

export async function revokeBrowserSession(pool, userId, sessionId) {
  await pool.query(
    `UPDATE "UserSessions" SET "RevokedAtUtc" = now(), "RevokedReason" = 'logout' WHERE "Id" = $1 AND "UserId" = $2 AND "RevokedAtUtc" IS NULL`,
    [sessionId, userId]);
}

/** Active businesses the user belongs to, for the in-app business switcher. */
export async function listUserBusinesses(pool, userId, currentBusinessId) {
  const { rows } = await withUserLookup(pool, userId, () => pool.query(
    `SELECT b."Id" AS "BusinessId", b."Name" AS "BusinessName", m."IsOwner" AS "IsOwner"
     FROM "Memberships" m JOIN "Businesses" b ON b."Id" = m."BusinessId"
     WHERE m."UserId" = $1 AND m."Status" = 0 AND b."IsActive" = TRUE ORDER BY b."Name"`, [userId]));
  return rows.map((row) => ({
    businessId: row.BusinessId, businessName: row.BusinessName,
    isOwner: Boolean(row.IsOwner), isCurrent: row.BusinessId === currentBusinessId,
  }));
}

/**
 * Moves a signed-in browser session to another business the user actively belongs to.
 * The new session is created first (it re-verifies membership inside a transaction), then the old one is
 * revoked, so a refused switch leaves the current session untouched.
 */
export async function switchBusiness(pool, env, auth, businessId) {
  // The new session belongs to the target business and the old one to the current business, so each part runs under its own context
  // (the request's context stays the current business until the old session is revoked).
  const created = await runWithTenantRlsContext(() => createBrowserSession(pool, env, { userId: auth.userId, businessId }));
  await pool.query(
    `UPDATE "UserSessions" SET "RevokedAtUtc" = now(), "RevokedReason" = 'business_switch'
     WHERE "Id" = $1 AND "UserId" = $2 AND "RevokedAtUtc" IS NULL`, [auth.sessionId, auth.userId]);
  await runWithTenantRlsContext(async () => {
    useBusiness(pool, businessId);
    await recordAudit(pool, businessId, auth.userId, 'auth.business_switched', 'BusinessMembership', auth.userId);
  });
  return { identity: { userId: auth.userId, businessId }, created };
}
