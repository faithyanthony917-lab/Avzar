import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { verifyPassword } from '../security/passwordHasher.js';
import { assertNotLocked, recordFailedAttempt } from '../security/accountLockout.js';
import { verifySecondFactor, withTransaction } from './accountService.js';
import { ensureBelowLimit, entitlementValue } from './entitlementService.js';
import { OWNER_PERMISSIONS } from './mobileAuthService.js';
import { lastPaidBillingPeriod } from './subscriptionBillingService.js';

export const AVAILABLE_PERMISSIONS = [
  'staff.view', 'staff.manage', 'roles.manage', 'locations.manage', 'locations.all', 'audit.view', 'business.settings',
  'customers.view', 'customers.manage', 'customers.merge', 'measurements.templates', 'measurements.record',
  'orders.view', 'orders.manage', 'orders.confirm', 'fittings.manage', 'tasks.view', 'tasks.manage', 'tasks.assign',
  'tasks.override', 'tasks.work', 'workflows.manage', 'workers.manage', 'designs.view', 'designs.manage', 'media.view',
  'media.manage', 'documents.view', 'documents.manage', 'pricing.view', 'pricing.manage', 'storefront.view',
  'storefront.edit', 'storefront.publish', 'inquiries.view', 'inquiries.manage', 'invoices.view', 'invoices.manage',
  'payments.view', 'payments.record', 'payments.verify', 'expenses.view', 'expenses.manage', 'inventory.view',
  'inventory.manage', 'reports.view',
];

const entitlementDefinitions = [
  ['users.max', 'Limit', 'Staff accounts', null, false],
  ['customers.active.max', 'Limit', 'Active customers', null, false],
  ['designs.max', 'Limit', 'Saved designs', null, false],
  ['storage.gb.max', 'Limit', 'Storage (GB)', null, false],
  ['storefront.count.max', 'Limit', 'Storefronts / catalogs', null, false],
  ['storefront.pages.max', 'Limit', 'Pages per storefront', null, false],
  ['orders.monthly.max', 'Limit', 'New orders per month', null, true],
  ['appointments.monthly.max', 'Limit', 'Appointments per month', null, true],
  ['storefront.builder', 'Flag', 'Visual storefront builder', null, false],
  ['storefront.custom_pages', 'Flag', 'Custom storefront pages', null, false],
  ['storefront.custom_domain', 'Flag', 'Custom domain', null, false],
  ['finance.partial_payments', 'Flag', 'Deposits, partial payments and credit notes', null, false],
  ['finance.expenses', 'Flag', 'Expense tracking', null, false],
  ['scheduling.individual', 'Flag', 'Individual worker schedules', null, false],
  ['scheduling.shop', 'Flag', 'Shop-wide schedule', null, false],
  ['scheduling.auto_planning', 'Flag', 'Automatic daily planning', null, false],
  ['ai.fashion_design', 'Flag', 'AI fashion design image generation', null, false],
  ['ai.assistant_builder', 'Flag', 'AI storefront assistant builder', null, false],
  ['ai.credits.daily', 'Limit', 'Daily AI credits', null, false],
  ['storefront.template_tier', 'Tier', 'Template tier', ['standard', 'basic', 'advanced', 'premium'], false],
  ['storefront.theme_level', 'Tier', 'Theme customization', ['none', 'basic', 'advanced', 'full'], false],
  ['storefront.branding_level', 'Tier', 'Branding controls', ['none', 'basic', 'advanced', 'full'], false],
  ['storefront.section_level', 'Tier', 'Section customization', ['none', 'basic', 'advanced', 'full'], false],
  ['inventory.level', 'Tier', 'Inventory', ['none', 'basic', 'full'], false],
  ['reports.level', 'Tier', 'Report depth', ['basic', 'standard', 'advanced', 'full'], false],
];

const defaultEntitlement = (kind, tiers) => kind === 'Flag' ? 'false' : kind === 'Limit' ? '0' : tiers[0];
const roleDto = (row) => ({ id: row.Id, name: row.Name, isSystem: row.IsSystem, permissions: row.Permissions ?? [] });
const hash = (text) => createHash('sha256').update(text).digest('hex');
const safeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const emailToken = () => randomBytes(32).toString('base64url');

async function audit(db, user, action, entityType, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
    VALUES ($1,$2,$3,$4,now(),$5::jsonb,$6,$7)`,
  [randomUUID(), user.userId, user.businessId, action, details === null ? null : JSON.stringify(details), entityId, entityType]);
}

async function writeAudit(db, businessId, actorId, action, entityType, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
    VALUES ($1,$2,$3,$4,now(),$5::jsonb,$6,$7)`,
  [randomUUID(), action, actorId, businessId, details === null ? null : JSON.stringify(details), entityId, entityType]);
}

async function queueEmail(db, { businessId = null, address, subject, text, html, templateKey }) {
  await db.query(`
    INSERT INTO "EmailOutbox" ("Id","Attempts","BusinessId","CreatedAtUtc","HtmlBody","NextAttemptUtc","Status","Subject","TemplateKey","TextBody","ToAddress")
    VALUES ($1,0,$2,now(),$3,now(),'Pending',$4,$5,$6,$7)`,
  [randomUUID(), businessId, html, subject, templateKey, text, address]);
}

async function validateRoleIds(db, businessId, roleIds) {
  const unique = [...new Set(roleIds)];
  const { rows } = unique.length ? await db.query(`
    SELECT "Id","Name","IsSystem" FROM "BusinessRoles" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`, [businessId, unique]) : { rows: [] };
  if (rows.length !== unique.length) throw AppError.badRequest('unknown_role', 'One or more roles do not exist.');
  if (rows.some((row) => row.IsSystem && row.Name === 'Owner')) throw AppError.forbidden('owner_role_protected', 'The Owner role cannot be assigned.');
  return unique;
}

async function validateLocationIds(db, businessId, locationIds) {
  const unique = [...new Set(locationIds)];
  const { rows } = unique.length ? await db.query(`
    SELECT "Id" FROM "Locations" WHERE "BusinessId" = $1 AND "IsActive" = TRUE AND "Id" = ANY($2::uuid[])`, [businessId, unique]) : { rows: [] };
  if (rows.length !== unique.length) throw AppError.badRequest('unknown_location', 'One or more locations do not exist or are inactive.');
  return unique;
}

export async function listStaff(pool, businessId) {
  const { rows } = await pool.query(`
    SELECT m."Id" AS "MembershipId",m."UserId",m."DisplayName",u."Email",m."IsOwner",m."Status",
      COALESCE((SELECT array_agg(mr."RoleId" ORDER BY mr."RoleId") FROM "MembershipRoles" mr WHERE mr."BusinessId" = m."BusinessId" AND mr."MembershipId" = m."Id"), ARRAY[]::uuid[]) AS "RoleIds",
      COALESCE((SELECT array_agg(ml."LocationId" ORDER BY ml."LocationId") FROM "MembershipLocations" ml WHERE ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id"), ARRAY[]::uuid[]) AS "LocationIds"
    FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE m."BusinessId" = $1 ORDER BY m."DisplayName"`, [businessId]);
  return rows.map((row) => ({ membershipId: row.MembershipId, userId: row.UserId, displayName: row.DisplayName,
    email: row.Email ?? '', isOwner: row.IsOwner, status: Number(row.Status) === 0 ? 'Active' : 'Deactivated',
    roleIds: row.RoleIds ?? [], locationIds: row.LocationIds ?? [] }));
}

export async function inviteStaff(pool, env, user, request) {
  const email = request.email.trim().toLowerCase();
  const roleIds = await validateRoleIds(pool, user.businessId, request.roleIds);
  const locationIds = await validateLocationIds(pool, user.businessId, request.locationIds ?? []);
  const alreadyMember = await pool.query(`
    SELECT 1 FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE m."BusinessId" = $1 AND u."NormalizedEmail" = $2 AND m."Status" = 0 LIMIT 1`,
  [user.businessId, email.toUpperCase()]);
  if (alreadyMember.rows.length) throw AppError.conflict('already_member', 'This person is already on your staff.');

  const id = randomUUID();
  const token = emailToken();
  const invitationDays = env.INVITATION_DAYS ?? 7;
  const expiresAtUtc = new Date(Date.now() + invitationDays * 86_400_000).toISOString();
  await withTransaction(pool, async (client) => {
    await ensureBelowLimit(client, user.businessId, 'users.max', async (db) => {
      const active = await db.query('SELECT count(*)::int AS "Count" FROM "Memberships" WHERE "BusinessId" = $1 AND "Status" = 0', [user.businessId]);
      const pending = await db.query(`
        SELECT count(*)::int AS "Count" FROM "Invitations" WHERE "BusinessId" = $1 AND lower("Email") <> lower($2)
          AND "AcceptedAtUtc" IS NULL AND "RevokedAtUtc" IS NULL AND "ExpiresAtUtc" > now()`, [user.businessId, email]);
      return Number(active.rows[0].Count) + Number(pending.rows[0].Count);
    });
    await client.query(`
      UPDATE "Invitations" SET "RevokedAtUtc" = now()
      WHERE "BusinessId" = $1 AND lower("Email") = lower($2) AND "AcceptedAtUtc" IS NULL AND "RevokedAtUtc" IS NULL`,
    [user.businessId, email]);
    await client.query(`
      INSERT INTO "Invitations" ("Id","BusinessId","Email","FullName","TokenHash","ExpiresAtUtc","InvitedByUserId","RoleIds","LocationIds","CreatedAtUtc")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9::uuid[],now())`,
    [id, user.businessId, email, request.fullName.trim(), hash(token), expiresAtUtc, user.userId, roleIds, locationIds]);
    await writeAudit(client, user.businessId, user.userId, 'staff.invited', 'StaffInvitation', id, { email, roleIds });
    const link = `${String(env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;
    const subject = "You've been invited to join a workshop on Avzar";
    const greeting = `Hello ${request.fullName.trim()},`;
    const line = `You have been invited to join a workshop on Avzar. The invitation is valid for ${invitationDays} days.`;
    const footer = 'If you were not expecting this invitation, you can ignore this email.';
    await queueEmail(client, { businessId: user.businessId, address: email, subject,
      text: `${greeting}\n\n${line}\n\nAccept invitation: ${link}\n\n${footer}`,
      html: `<p>${safeHtml(greeting)}</p><p>${safeHtml(line)}</p><p><a href="${safeHtml(link)}">Accept invitation</a></p><p>${safeHtml(footer)}</p>`,
      templateKey: 'staff_invitation' });
  });
  return { id, email, expiresAtUtc };
}

async function loadMembership(db, businessId, actorId, membershipId, includeLinks = false) {
  const { rows } = await db.query(`
    SELECT "Id","UserId","IsOwner","Status" FROM "Memberships"
    WHERE "BusinessId" = $1 AND "Id" = $2 ${includeLinks ? 'FOR UPDATE' : ''}`, [businessId, membershipId]);
  if (!rows.length) throw AppError.notFound('staff_not_found', 'Staff member not found.');
  const member = rows[0];
  if (includeLinks) {
    const [roles, locations] = await Promise.all([
      db.query('SELECT "RoleId" FROM "MembershipRoles" WHERE "BusinessId" = $1 AND "MembershipId" = $2', [businessId, membershipId]),
      db.query('SELECT "LocationId" FROM "MembershipLocations" WHERE "BusinessId" = $1 AND "MembershipId" = $2', [businessId, membershipId]),
    ]);
    member.RoleIds = roles.rows.map((row) => row.RoleId);
    member.LocationIds = locations.rows.map((row) => row.LocationId);
  }
  return member;
}

export async function changeStaffStatus(pool, user, membershipId, reactivate) {
  await withTransaction(pool, async (client) => {
    const member = await loadMembership(client, user.businessId, user.userId, membershipId, true);
    if (!reactivate) {
      if (member.IsOwner) throw AppError.forbidden('owner_protected', 'The owner cannot be deactivated.');
      if (member.UserId === user.userId) throw AppError.forbidden('self_deactivation', 'You cannot deactivate yourself.');
      if (Number(member.Status) === 1) return;
      await client.query('UPDATE "Memberships" SET "Status" = 1,"DeactivatedAtUtc" = now(),"UpdatedAtUtc" = now() WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, membershipId]);
      await writeAudit(client, user.businessId, user.userId, 'staff.deactivated', 'BusinessMembership', membershipId);
      return;
    }
    if (Number(member.Status) === 0) return;
    await ensureBelowLimit(client, user.businessId, 'users.max', async (db) => {
      const active = await db.query('SELECT count(*)::int AS "Count" FROM "Memberships" WHERE "BusinessId" = $1 AND "Status" = 0', [user.businessId]);
      const pending = await db.query(`SELECT count(*)::int AS "Count" FROM "Invitations" WHERE "BusinessId" = $1
        AND "AcceptedAtUtc" IS NULL AND "RevokedAtUtc" IS NULL AND "ExpiresAtUtc" > now()`, [user.businessId]);
      return Number(active.rows[0].Count) + Number(pending.rows[0].Count);
    });
    await client.query('UPDATE "Memberships" SET "Status" = 0,"DeactivatedAtUtc" = NULL,"UpdatedAtUtc" = now() WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, membershipId]);
    await writeAudit(client, user.businessId, user.userId, 'staff.reactivated', 'BusinessMembership', membershipId);
  });
}

export async function setStaffRoles(pool, user, membershipId, requestedRoleIds) {
  await withTransaction(pool, async (client) => {
    const member = await loadMembership(client, user.businessId, user.userId, membershipId, true);
    if (member.IsOwner) throw AppError.forbidden('owner_protected', "The owner's roles cannot be changed.");
    const roleIds = await validateRoleIds(client, user.businessId, requestedRoleIds);
    await client.query('DELETE FROM "MembershipRoles" WHERE "BusinessId" = $1 AND "MembershipId" = $2', [user.businessId, membershipId]);
    for (const roleId of roleIds) await client.query('INSERT INTO "MembershipRoles" ("MembershipId","RoleId","BusinessId") VALUES ($1,$2,$3)', [membershipId, roleId, user.businessId]);
    await writeAudit(client, user.businessId, user.userId, 'staff.roles_changed', 'BusinessMembership', membershipId,
      { before: member.RoleIds, after: roleIds });
  });
}

export async function setStaffLocations(pool, user, membershipId, requestedLocationIds) {
  await withTransaction(pool, async (client) => {
    const member = await loadMembership(client, user.businessId, user.userId, membershipId, true);
    const locationIds = await validateLocationIds(client, user.businessId, requestedLocationIds ?? []);
    await client.query('DELETE FROM "MembershipLocations" WHERE "BusinessId" = $1 AND "MembershipId" = $2', [user.businessId, membershipId]);
    for (const locationId of locationIds) await client.query('INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)', [membershipId, locationId, user.businessId]);
    await writeAudit(client, user.businessId, user.userId, 'staff.locations_changed', 'BusinessMembership', membershipId,
      { before: member.LocationIds, after: locationIds });
  });
}

export async function listRoles(pool, businessId) {
  const { rows } = await pool.query(`
    SELECT r."Id",r."Name",r."IsSystem",COALESCE(array_agg(rp."Permission" ORDER BY rp."Permission") FILTER (WHERE rp."Permission" IS NOT NULL),ARRAY[]::text[]) AS "Permissions"
    FROM "BusinessRoles" r LEFT JOIN "RolePermissions" rp ON rp."BusinessId" = r."BusinessId" AND rp."RoleId" = r."Id"
    WHERE r."BusinessId" = $1 GROUP BY r."Id" ORDER BY r."Name"`, [businessId]);
  return rows.map(roleDto);
}

function cleanPermissions(values) {
  const list = [...new Set(values.map((value) => String(value).trim()))];
  const invalid = list.filter((value) => !AVAILABLE_PERMISSIONS.includes(value));
  if (invalid.length) throw AppError.badRequest('unknown_permission', `Unknown permission(s): ${invalid.join(', ')}`);
  return list;
}

export async function createRole(pool, user, request) {
  const name = request.name.trim();
  const permissions = cleanPermissions(request.permissions ?? []);
  const id = randomUUID();
  await withTransaction(pool, async (client) => {
    const found = await client.query('SELECT 1 FROM "BusinessRoles" WHERE "BusinessId" = $1 AND lower("Name") = lower($2) LIMIT 1', [user.businessId, name]);
    if (found.rows.length) throw AppError.conflict('role_exists', 'A role with this name already exists.');
    await client.query('INSERT INTO "BusinessRoles" ("Id","BusinessId","Name","IsSystem","CreatedAtUtc") VALUES ($1,$2,$3,FALSE,now())', [id, user.businessId, name]);
    for (const permission of permissions) await client.query('INSERT INTO "RolePermissions" ("RoleId","Permission","BusinessId") VALUES ($1,$2,$3)', [id, permission, user.businessId]);
    await writeAudit(client, user.businessId, user.userId, 'role.created', 'BusinessRole', id, { name, permissions });
  });
  return { id, name, isSystem: false, permissions: permissions.sort() };
}

export async function setRolePermissions(pool, user, roleId, requestedPermissions) {
  const permissions = cleanPermissions(requestedPermissions ?? []);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query('SELECT "Id","Name","IsSystem" FROM "BusinessRoles" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE', [user.businessId, roleId]);
    if (!rows.length) throw AppError.notFound('role_not_found', 'Role not found.');
    if (rows[0].IsSystem && rows[0].Name === 'Owner') throw AppError.forbidden('owner_role_protected', 'The Owner role cannot be edited.');
    const previous = await client.query('SELECT "Permission" FROM "RolePermissions" WHERE "BusinessId" = $1 AND "RoleId" = $2 ORDER BY "Permission"', [user.businessId, roleId]);
    await client.query('DELETE FROM "RolePermissions" WHERE "BusinessId" = $1 AND "RoleId" = $2', [user.businessId, roleId]);
    for (const permission of permissions) await client.query('INSERT INTO "RolePermissions" ("RoleId","Permission","BusinessId") VALUES ($1,$2,$3)', [roleId, permission, user.businessId]);
    await writeAudit(client, user.businessId, user.userId, 'role.permissions_changed', 'BusinessRole', roleId,
      { before: previous.rows.map((row) => row.Permission), after: permissions });
    return { id: roleId, name: rows[0].Name, isSystem: rows[0].IsSystem, permissions: permissions.sort() };
  });
}

export async function listLocations(pool, businessId) {
  const { rows } = await pool.query(`SELECT "Id","Name","Address","IsActive" FROM "Locations" WHERE "BusinessId" = $1 ORDER BY "Name"`, [businessId]);
  return rows.map((row) => ({ id: row.Id, name: row.Name, address: row.Address, isActive: row.IsActive }));
}

export async function listAudit(pool, businessId, query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 25 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  const values = [businessId];
  const filters = ['a."BusinessId" = $1'];
  for (const [key, column] of [['action','Action'],['entityType','EntityType']]) {
    if (query[key] !== undefined && String(query[key]).trim()) {
      values.push(String(query[key]).trim());
      filters.push(`a."${column}" = $${values.length}`);
    }
  }
  for (const [key, column] of [['entityId','EntityId'],['actorUserId','ActorUserId']]) {
    if (query[key] !== undefined && String(query[key]).trim()) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(query[key]))) {
        throw AppError.badRequest(`invalid_${key}`, `The ${key} must be a valid ID.`);
      }
      values.push(String(query[key]));
      filters.push(`a."${column}" = $${values.length}`);
    }
  }
  for (const [key, operator] of [['fromUtc','>='],['toUtc','<']]) {
    if (query[key] !== undefined && String(query[key]).trim()) {
      const date = new Date(String(query[key]));
      if (!Number.isFinite(date.getTime())) throw AppError.badRequest(`invalid_${key}`, `${key} must be a valid date-time.`);
      values.push(date.toISOString());
      filters.push(`a."CreatedAtUtc" ${operator} $${values.length}::timestamptz`);
    }
  }
  const where = filters.join(' AND ');
  const count = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "AuditLogs" a WHERE ${where}`, values);
  const { rows } = await pool.query(`
    SELECT a."Id",a."CreatedAtUtc",a."ActorUserId",u."FullName" AS "ActorName",a."Action",a."EntityType",a."EntityId",a."DetailsJson"
    FROM "AuditLogs" a LEFT JOIN "AspNetUsers" u ON u."Id" = a."ActorUserId"
    WHERE ${where} ORDER BY a."CreatedAtUtc" DESC,a."Id" DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
  [...values, pageSize, (page - 1) * pageSize]);
  return { items: rows.map((row) => ({ id: row.Id, createdAtUtc: row.CreatedAtUtc, actorUserId: row.ActorUserId,
    actorName: row.ActorName, action: row.Action, entityType: row.EntityType, entityId: row.EntityId, detailsJson: row.DetailsJson })),
    page, pageSize, totalCount: Number(count.rows[0]?.TotalCount ?? 0) };
}

export async function createLocation(pool, user, request) {
  const name = request.name.trim();
  const id = randomUUID();
  await withTransaction(pool, async (client) => {
    const exists = await client.query('SELECT 1 FROM "Locations" WHERE "BusinessId" = $1 AND "Name" = $2 LIMIT 1', [user.businessId, name]);
    if (exists.rows.length) throw AppError.conflict('location_exists', 'A location with this name already exists.');
    await client.query('INSERT INTO "Locations" ("Id","BusinessId","Name","Address","IsActive","CreatedAtUtc") VALUES ($1,$2,$3,$4,TRUE,now())',
      [id, user.businessId, name, request.address?.trim() || null]);
    await writeAudit(client, user.businessId, user.userId, 'location.created', 'BusinessLocation', id, { name });
  });
  return { id, name, address: request.address?.trim() || null, isActive: true };
}

export async function getPublicPlans(pool) {
  const [definitions, plans] = await Promise.all([
    Promise.resolve(entitlementDefinitions.map(([key, kind, description, tiers, periodic]) => ({ key, kind, description, tiers, periodic }))),
    pool.query(`
      SELECT p."Id",p."Code",p."Name",p."Description",p."CurrencyCode",p."MonthlyPrice",p."AnnualPrice",
        COALESCE(jsonb_object_agg(pe."Key",pe."Value") FILTER (WHERE pe."Key" IS NOT NULL),'{}'::jsonb) AS "Entitlements"
      FROM "Plans" p LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id"
      WHERE p."IsActive" GROUP BY p."Id" ORDER BY p."SortOrder"`),
  ]);
  return {
    entitlements: definitions,
    plans: plans.rows.map((row) => ({ code: row.Code, name: row.Name, description: row.Description,
      currencyCode: row.CurrencyCode, monthlyPrice: Number(row.MonthlyPrice), annualPrice: row.AnnualPrice == null ? null : Number(row.AnnualPrice),
      entitlements: row.Entitlements ?? {} })),
  };
}

export async function getTenantEntitlements(pool, businessId, env = {}) {
  const { rows: subscriptionRows } = await pool.query(`
    SELECT s."Status",s."CurrentPeriodEndUtc",s."TrialStartedAtUtc",s."GraceEndsAtUtc",s."SuspendedAtUtc",
      p."Id" AS "PlanId",p."Code",p."Name",pp."Code" AS "PendingPlanCode",pp."Name" AS "PendingPlanName"
    FROM "Subscriptions" s JOIN "Plans" p ON p."Id" = s."PlanId" LEFT JOIN "Plans" pp ON pp."Id" = s."PendingPlanId"
    WHERE s."BusinessId" = $1 LIMIT 1`, [businessId]);
  const raw = subscriptionRows[0] ?? null;
  let subscription = raw;
  const suspended = raw?.Status === 'Expired';
  if (!subscription || suspended) {
    const free = await pool.query('SELECT "Id","Code","Name" FROM "Plans" WHERE "Code" = $1 LIMIT 1', ['free']);
    if (!free.rows.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');
    subscription = { ...free.rows[0], Status: subscription?.Status ?? 'Active' };
  }
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  const onFree = subscription.Code === 'free';
  const lifecycle = {
    currentPeriodEndUtc: iso(raw?.CurrentPeriodEndUtc),
    trialEndsAtUtc: raw?.Status === 'Trialing' ? iso(raw.CurrentPeriodEndUtc) : null,
    graceEndsAtUtc: raw?.Status === 'PastDue' ? iso(raw.GraceEndsAtUtc) : null,
    suspendedAtUtc: suspended ? iso(raw.SuspendedAtUtc) : null,
    suspendedPlanCode: suspended ? raw.Code : null, // the paid plan that lapsed; Free limits apply meanwhile
    pendingPlanCode: raw?.PendingPlanCode ?? null,
    pendingPlanName: raw?.PendingPlanName ?? null,
    trialDays: env.BILLING_TRIAL_DAYS ?? 14,
    canStartTrial: !raw?.TrialStartedAtUtc && onFree && !suspended && (subscription.Status === 'Active'),
  };
  // The period the current paid plan was last bought for, so the UI can tell a monthly renewal from a monthly -> annual switch.
  const billingPeriod = raw?.Status === 'Active' && !onFree && raw.PlanId ? await lastPaidBillingPeriod(pool, businessId, raw.PlanId) : null;
  const itemValues = await Promise.all(entitlementDefinitions.map(([key, kind, description, tiers, periodic]) =>
    entitlementValue(pool, businessId, key, defaultEntitlement(kind, tiers ?? []))));
  const currentMonth = new Date();
  const periodStart = `${currentMonth.getUTCFullYear()}-${String(currentMonth.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
  const items = [];
  for (let index = 0; index < entitlementDefinitions.length; index += 1) {
    const [key, kind, description, _tiers, periodic] = entitlementDefinitions[index];
    let used = null;
    let exactUsed = null;
    if (key === 'users.max') {
      const [members, invites] = await Promise.all([
        pool.query('SELECT count(*)::bigint AS "Count" FROM "Memberships" WHERE "BusinessId" = $1 AND "Status" = 0', [businessId]),
        pool.query('SELECT count(*)::bigint AS "Count" FROM "Invitations" WHERE "BusinessId" = $1 AND "AcceptedAtUtc" IS NULL AND "RevokedAtUtc" IS NULL AND "ExpiresAtUtc" > now()', [businessId]),
      ]);
      used = Number(members.rows[0].Count) + Number(invites.rows[0].Count);
    } else if (key === 'customers.active.max') {
      const result = await pool.query('SELECT count(*)::bigint AS "Count" FROM "Customers" WHERE "BusinessId" = $1 AND "Status" = \'Active\'', [businessId]);
      used = Number(result.rows[0].Count);
    } else if (key === 'designs.max') {
      // Same count that enforcement uses when a design is created or restored.
      const result = await pool.query('SELECT count(*)::bigint AS "Count" FROM "Designs" WHERE "BusinessId" = $1 AND "Status" = \'Active\'', [businessId]);
      used = Number(result.rows[0]?.Count ?? 0);
    } else if (key === 'storefront.count.max') {
      const result = await pool.query('SELECT count(*)::bigint AS "Count" FROM "Storefronts" WHERE "BusinessId" = $1', [businessId]);
      used = Number(result.rows[0]?.Count ?? 0);
    } else if (key === 'storage.gb.max') {
      // Media plus documents, the same total the upload quota check uses. Shown in GB (2 decimals); the over-limit test uses exact bytes.
      const result = await pool.query(`SELECT (COALESCE((SELECT sum("SizeBytes") FROM "MediaAssets" WHERE "BusinessId" = $1), 0)
        + COALESCE((SELECT sum("SizeBytes") FROM "Documents" WHERE "BusinessId" = $1), 0))::text AS "UsedBytes"`, [businessId]);
      const bytesPerGb = env.STORAGE_QUOTA_BYTES_PER_GB ?? 1_073_741_824;
      const usedBytes = Number(result.rows[0]?.UsedBytes ?? '0');
      used = Math.round((usedBytes / bytesPerGb) * 100) / 100;
      exactUsed = usedBytes / bytesPerGb;
    } else if (periodic) {
      const result = await pool.query('SELECT "Count" FROM "UsageCounters" WHERE "BusinessId" = $1 AND "Key" = $2 AND "PeriodStartUtc" = $3::timestamptz', [businessId, key, periodStart]);
      used = Number(result.rows[0]?.Count ?? 0);
    }
    const value = itemValues[index];
    // Over the limit is informational: existing records are kept, only adding more is blocked until the plan or usage changes.
    const overLimit = used !== null && /^\d+$/.test(value) && (exactUsed ?? used) > Number(value);
    items.push({ key, kind, description, value, used, overLimit });
  }
  return { planCode: subscription.Code, planName: subscription.Name, status: subscription.Status, billingPeriod, ...lifecycle, items };
}

export async function listPlatformPlans(pool, userEmail, configuredEmails) {
  requirePlatformAdmin(userEmail, configuredEmails);
  const { rows } = await pool.query(`
    SELECT p."Id",p."Code",p."Name",p."Description",p."IsActive",p."SortOrder",p."CurrencyCode",p."MonthlyPrice",p."AnnualPrice",
      COALESCE(jsonb_object_agg(pe."Key",pe."Value") FILTER (WHERE pe."Key" IS NOT NULL),'{}'::jsonb) AS "Entitlements"
    FROM "Plans" p LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id"
    GROUP BY p."Id" ORDER BY p."SortOrder"`);
  return rows.map((row) => ({ id: row.Id, code: row.Code, name: row.Name, description: row.Description,
    isActive: row.IsActive, sortOrder: row.SortOrder, currencyCode: row.CurrencyCode,
    monthlyPrice: Number(row.MonthlyPrice), annualPrice: row.AnnualPrice == null ? null : Number(row.AnnualPrice), entitlements: row.Entitlements ?? {} }));
}

export async function listEmailSuppressions(pool, userEmail, configuredEmails, { q, limit = 200 } = {}) {
  requirePlatformAdmin(userEmail, configuredEmails);
  const take = Math.min(500, Math.max(1, limit));
  const term = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null;
  const { rows } = await pool.query(`
    SELECT "Id","Address","Reason","CreatedAtUtc" FROM "EmailSuppressions"
    WHERE $1::text IS NULL OR strpos(lower("Address"), $1) > 0
    ORDER BY "CreatedAtUtc" DESC LIMIT $2`, [term, take]);
  return {
    items: rows.map((row) => ({ id: row.Id, address: row.Address, reason: row.Reason, createdAtUtc: row.CreatedAtUtc })),
    limit: take,
  };
}

function requirePlatformAdmin(email, configuredEmails) {
  const allowed = new Set(configuredEmails.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!email || !allowed.has(email.trim().toLowerCase())) throw AppError.forbidden('platform_admin_required', 'Platform administrator access is required.');
}

export async function updatePlatformPlan(pool, userEmail, configuredEmails, code, request) {
  requirePlatformAdmin(userEmail, configuredEmails);
  if (!request.name.trim() || request.name.length > 80 || request.currencyCode.length !== 3 || !Number.isSafeInteger(Math.round(request.monthlyPrice * 100)) || request.monthlyPrice < 0 || (request.annualPrice != null && (request.annualPrice < 0 || !Number.isSafeInteger(Math.round(request.annualPrice * 100)))) ) {
    throw AppError.badRequest('invalid_plan', 'Name, currency and non-negative prices are required.');
  }
  for (const [key, value] of Object.entries(request.entitlements)) {
    const definition = entitlementDefinitions.find(([candidate]) => candidate === key);
    if (!definition) throw AppError.badRequest('invalid_entitlement', `Unknown entitlement '${key}'.`);
    const [, kind, , tiers] = definition;
    const valid = kind === 'Flag' ? ['true', 'false'].includes(value)
      : kind === 'Limit' ? value === 'unlimited' || /^(0|[1-9]\d*)$/.test(value)
        : tiers.includes(value);
    if (!valid) throw AppError.badRequest('invalid_entitlement', `Invalid value for entitlement '${key}'.`);
  }
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query('SELECT "Id" FROM "Plans" WHERE "Code" = $1 FOR UPDATE', [code]);
    if (!rows.length) throw AppError.notFound('plan_not_found', 'Plan was not found.');
    await client.query(`
      UPDATE "Plans" SET "Name" = $1,"Description" = $2,"IsActive" = $3,"SortOrder" = $4,"CurrencyCode" = $5,
        "MonthlyPrice" = $6,"AnnualPrice" = $7,"UpdatedAtUtc" = now() WHERE "Id" = $8`,
    [request.name.trim(), request.description?.trim() || null, request.isActive, request.sortOrder, request.currencyCode.toUpperCase(),
      request.monthlyPrice.toFixed(2), request.annualPrice == null ? null : request.annualPrice.toFixed(2), rows[0].Id]);
    for (const [key, value] of Object.entries(request.entitlements)) {
      await client.query(`INSERT INTO "PlanEntitlements" ("PlanId","Key","Value") VALUES ($1,$2,$3)
        ON CONFLICT ("PlanId","Key") DO UPDATE SET "Value" = EXCLUDED."Value"`, [rows[0].Id, key, value]);
    }
  });
}

export async function requestOwnershipTransfer(pool, env, user, request) {
  const base = env.PUBLIC_BASE_URL ?? env.WEB_BASE_URL;
  let url;
  try { url = new URL(base); } catch { throw new Error('Set PUBLIC_BASE_URL to the public HTTPS Avzar web URL before enabling ownership transfer.'); }
  if (url.protocol !== 'https:' && !(env.ALLOW_INSECURE_PUBLIC_BASE_URL && url.protocol === 'http:')) {
    throw new Error('Set PUBLIC_BASE_URL to the public HTTPS Avzar web URL before enabling ownership transfer.');
  }
  const { rows: userRows } = await pool.query(`SELECT "Email","FullName","PasswordHash","TwoFactorEnabled","LockoutEnd" FROM "AspNetUsers" WHERE "Id" = $1`, [user.userId]);
  const actor = userRows[0];
  if (!actor || (actor.LockoutEnd && new Date(actor.LockoutEnd).getTime() >= 8.64e15)) throw AppError.unauthorized('unknown_user', 'Unknown user.');
  await assertNotLocked(pool, user.userId);
  if (!(await verifyPassword(actor.PasswordHash, request.password)).ok) {
    await recordFailedAttempt(pool, user.userId);
    throw AppError.badRequest('wrong_password', 'The password is incorrect.');
  }
  if (actor.TwoFactorEnabled && !(await verifySecondFactor(pool, user.userId, request.twoFactorCode, request.recoveryCode))) {
    await recordFailedAttempt(pool, user.userId);
    throw AppError.badRequest('invalid_code', 'The authentication code is not correct.');
  }
  if (!actor.Email || !/^\S+@\S+\.\S+$/.test(actor.Email)) throw AppError.badRequest('owner_email_required', 'Add a valid email address to your account before transferring ownership.');
  const token = randomBytes(32).toString('hex');
  const id = randomUUID();
  const validMinutes = 30;
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [`ownership:${user.businessId}`]);
    const current = await client.query('SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0 AND "IsOwner" FOR UPDATE', [user.businessId, user.userId]);
    if (!current.rows.length) throw AppError.forbidden('owner_required', 'Only the business owner can transfer ownership.');
    const target = await client.query(`SELECT m."Id" FROM "Memberships" m WHERE m."BusinessId" = $1 AND m."Id" = $2 AND m."Status" = 0`,
      [user.businessId, request.newOwnerMembershipId]);
    if (!target.rows.length) throw AppError.notFound('staff_not_found', 'Staff member not found.');
    if (target.rows[0].Id === current.rows[0].Id) throw AppError.badRequest('same_person', 'Choose someone other than yourself.');
    await client.query(`UPDATE "OwnershipTransferChallenges" SET "CancelledAtUtc" = now(),"UpdatedAtUtc" = now()
      WHERE "BusinessId" = $1 AND "RequestingUserId" = $2 AND "ConsumedAtUtc" IS NULL AND "CancelledAtUtc" IS NULL`, [user.businessId, user.userId]);
    await client.query(`INSERT INTO "OwnershipTransferChallenges" ("Id","BusinessId","RequestingUserId","NewOwnerMembershipId","TokenHash","ExpiresAtUtc","CreatedAtUtc")
      VALUES ($1,$2,$3,$4,$5,now() + interval '30 minutes',now())`, [id, user.businessId, user.userId, request.newOwnerMembershipId, hash(token)]);
    const business = await client.query('SELECT "Name" FROM "Businesses" WHERE "Id" = $1', [user.businessId]);
    const businessName = business.rows[0]?.Name ?? 'your business';
    const link = new URL(`/ownership-transfer/confirm?token=${encodeURIComponent(token)}`, url).toString();
    const subject = `Confirm ownership transfer for ${businessName}`;
    const greeting = `Hello ${actor.FullName || actor.Email},`;
    const text = `${greeting}\n\nA request was made to transfer ownership of ${businessName} on Avzar. Confirm this request only if you initiated it.\n\nThis single-use confirmation link expires in ${validMinutes} minutes. Ownership will not change until you open the link while signed in and confirm.\n\nReview and confirm transfer: ${link}\n\nIf you did not request this transfer, ignore this email. Ownership has not changed.`;
    const html = `<p>${safeHtml(greeting)}</p><p>A request was made to transfer ownership of ${safeHtml(businessName)} on Avzar. Confirm this request only if you initiated it.</p><p>This single-use confirmation link expires in ${validMinutes} minutes. Ownership will not change until you open the link while signed in and confirm.</p><p><a href="${safeHtml(link)}">Review and confirm transfer</a></p><p>If you did not request this transfer, ignore this email. Ownership has not changed.</p>`;
    await queueEmail(client, { businessId: user.businessId, address: actor.Email, subject, text, html, templateKey: 'ownership_transfer_verification' });
    await writeAudit(client, user.businessId, user.userId, 'business.ownership_transfer_verification_requested', 'OwnershipTransferChallenge', id,
      { targetMembershipId: request.newOwnerMembershipId, expiresInMinutes: validMinutes });
  });
}

export async function confirmOwnershipTransfer(pool, user) {
  return withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [`ownership:${user.businessId}`]);
    const challenges = await db.query(`SELECT "Id","NewOwnerMembershipId" FROM "OwnershipTransferChallenges"
      WHERE "BusinessId" = $1 AND "RequestingUserId" = $2 AND "TokenHash" = $3 AND "ConsumedAtUtc" IS NULL AND "CancelledAtUtc" IS NULL AND "ExpiresAtUtc" > now() FOR UPDATE`,
    [user.businessId, user.userId, hash(user.token)]);
    if (!challenges.rows.length) throw AppError.badRequest('invalid_transfer_token', 'The ownership confirmation link is invalid or expired.');
    const challenge = challenges.rows[0];
    const currentResult = await db.query(`SELECT m."Id",m."UserId",m."DisplayName" FROM "Memberships" m
      WHERE m."BusinessId" = $1 AND m."UserId" = $2 AND m."Status" = 0 AND m."IsOwner" FOR UPDATE`, [user.businessId, user.userId]);
    if (!currentResult.rows.length) throw AppError.forbidden('owner_required', 'Only the business owner can transfer ownership.');
    const current = currentResult.rows[0];
    const targetResult = await db.query(`SELECT m."Id",m."UserId",m."DisplayName",m."Status",m."IsOwner" FROM "Memberships" m
      WHERE m."BusinessId" = $1 AND m."Id" = $2 FOR UPDATE`, [user.businessId, challenge.NewOwnerMembershipId]);
    if (!targetResult.rows.length) throw AppError.notFound('staff_not_found', 'Staff member not found.');
    const target = targetResult.rows[0];
    if (target.Id === current.Id) throw AppError.badRequest('same_person', 'Choose someone other than yourself.');
    if (target.IsOwner) throw AppError.conflict('already_owner', 'That person is already the owner.');
    if (Number(target.Status) !== 0) throw AppError.badRequest('target_inactive', 'Reactivate this staff member before making them the owner.');
    const users = await db.query('SELECT "Email","FullName","LockoutEnd" FROM "AspNetUsers" WHERE "Id" = ANY($1::uuid[])', [[current.UserId, target.UserId]]);
    const formerUser = users.rows.find((row) => row.Email === user.email) ?? users.rows[0];
    const targetUser = users.rows.find((row) => row.Email !== user.email) ?? users.rows[1];
    if (!targetUser || (targetUser.LockoutEnd && new Date(targetUser.LockoutEnd).getTime() >= 8.64e15)) throw AppError.badRequest('target_unavailable', 'That account is no longer available.');
    const roleRows = await db.query(`SELECT "Id","Name" FROM "BusinessRoles" WHERE "BusinessId" = $1 AND "IsSystem" AND "Name" IN ('Owner','Manager')`, [user.businessId]);
    const ownerRole = roleRows.rows.find((row) => row.Name === 'Owner');
    const managerRole = roleRows.rows.find((row) => row.Name === 'Manager');
    if (!ownerRole) throw new AppError(500, 'owner_role_missing', 'The Owner role is missing for this business.');
    await db.query('UPDATE "OwnershipTransferChallenges" SET "ConsumedAtUtc" = now(),"UpdatedAtUtc" = now() WHERE "Id" = $1', [challenge.Id]);
    await db.query('UPDATE "Memberships" SET "IsOwner" = FALSE,"UpdatedAtUtc" = now() WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, current.Id]);
    await db.query('DELETE FROM "MembershipRoles" WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "RoleId" = $3', [user.businessId, current.Id, ownerRole.Id]);
    if (managerRole) await db.query(`INSERT INTO "MembershipRoles" ("MembershipId","RoleId","BusinessId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [current.Id, managerRole.Id, user.businessId]);
    await db.query('UPDATE "Memberships" SET "IsOwner" = TRUE,"UpdatedAtUtc" = now() WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, target.Id]);
    await db.query(`INSERT INTO "MembershipRoles" ("MembershipId","RoleId","BusinessId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [target.Id, ownerRole.Id, user.businessId]);
    await writeAudit(db, user.businessId, user.userId, 'business.ownership_transferred', 'BusinessMembership', target.Id,
      { fromMembershipId: current.Id, toMembershipId: target.Id });
    const business = await db.query('SELECT "Name" FROM "Businesses" WHERE "Id" = $1', [user.businessId]);
    const businessName = business.rows[0]?.Name ?? '';
    const formerName = current.DisplayName || formerUser?.FullName || formerUser?.Email || '';
    const targetName = target.DisplayName || targetUser.FullName || targetUser.Email || '';
    if (targetUser.Email) await queueEmail(db, { businessId: user.businessId, address: targetUser.Email,
      subject: `You are now the owner of ${businessName}`,
      text: `${targetName},\n\n${formerName} has made you the owner of ${businessName} on Avzar. You now have the Owner role.`,
      html: `<p>${safeHtml(targetName)},</p><p>${safeHtml(formerName)} has made you the owner of ${safeHtml(businessName)} on Avzar. You now have the Owner role.</p>`,
      templateKey: 'ownership_received' });
    if (formerUser?.Email) await queueEmail(db, { businessId: user.businessId, address: formerUser.Email,
      subject: `Ownership of ${businessName} was transferred`,
      text: `${formerName},\n\nOwnership of ${businessName} on Avzar was transferred to ${targetName}. Your Owner role has ended${managerRole ? ' and you now have the Manager role' : ''}.`,
      html: `<p>${safeHtml(formerName)},</p><p>Ownership of ${safeHtml(businessName)} on Avzar was transferred to ${safeHtml(targetName)}. Your Owner role has ended${managerRole ? ' and you now have the Manager role' : ''}.</p>`,
      templateKey: 'ownership_handed_over' });
    return true;
  });
}
