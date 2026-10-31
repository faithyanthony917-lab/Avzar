// Step 17b: platform administrator screens. Read-only, except for the audit entries these views leave.
// Who may call: PLATFORM_ADMIN_EMAILS only (requirePlatformAdmin). What is shown: businesses, staff accounts, counts and queue depth.
// Never shown: customer names or contacts, password hashes, tokens, message bodies.
// How rows of other businesses are reached under forced row-level security:
//   - Businesses, AspNetUsers, Plans, PlatformAuditLogs have no BusinessId and need no special access;
//   - per-business counts run inside that one business's own tenant context;
//   - a user's memberships come through the existing user-ID lookup policy (0033);
//   - queue depth uses the read-only platform-admin policies of migration 0043.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from '../http/errors.js';
import { runWithPlatformAdminRead, runWithTenantRlsContext, setTenantLookup, setTenantRlsContext } from '../db/tenantRlsContext.js';
import { requirePlatformAdmin } from './platformAccess.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE = 25;

function takeFrom(limit) { return Math.min(100, Math.max(1, Number(limit) || PAGE)); }
function likePattern(text) { return `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; }

/** An opaque keyset cursor: the time and ID of the last row on the page. */
export function encodeCursor(row) { return Buffer.from(JSON.stringify({ t: new Date(row.CreatedAtUtc).toISOString(), id: row.Id }), 'utf8').toString('base64url'); }
export function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (typeof parsed.t === 'string' && !Number.isNaN(Date.parse(parsed.t)) && typeof parsed.id === 'string' && UUID.test(parsed.id)) return { t: parsed.t, id: parsed.id };
  } catch { /* fall through */ }
  throw AppError.badRequest('invalid_cursor', 'The page marker is not valid.');
}

async function writeAudit(pool, actorEmail, action, entityType, entityId, details) {
  await pool.query(`INSERT INTO "PlatformAuditLogs" ("Id","ActorEmail","Action","EntityType","EntityId","DetailsJson") VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [randomUUID(), actorEmail.trim().toLowerCase(), action, entityType, entityId, JSON.stringify(details ?? {})]);
}

export async function listPlatformBusinesses(pool, actorEmail, allowlist, { q, limit, before } = {}) {
  requirePlatformAdmin(actorEmail, allowlist);
  const take = takeFrom(limit);
  const cursor = decodeCursor(before);
  const search = q && String(q).trim() ? likePattern(String(q).trim().slice(0, 100)) : null;
  const { rows } = await pool.query(`
    SELECT "Id","Name","ContactEmail","CurrencyCode","TimeZoneId","IsActive","CreatedAtUtc" FROM "Businesses"
    WHERE ($1::text IS NULL OR "Name" ILIKE $1 OR "ContactEmail" ILIKE $1)
      AND ($2::timestamptz IS NULL OR ("CreatedAtUtc", "Id") < ($2::timestamptz, $3::uuid))
    ORDER BY "CreatedAtUtc" DESC, "Id" DESC LIMIT $4`, [search, cursor?.t ?? null, cursor?.id ?? null, take + 1]);
  const page = rows.slice(0, take);
  return {
    items: page.map((r) => ({ id: r.Id, name: r.Name, contactEmail: r.ContactEmail, currencyCode: r.CurrencyCode, timeZoneId: r.TimeZoneId, isActive: r.IsActive, createdAtUtc: r.CreatedAtUtc })),
    next: rows.length > take ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function getPlatformBusiness(pool, actorEmail, allowlist, businessId) {
  requirePlatformAdmin(actorEmail, allowlist);
  if (!UUID.test(String(businessId))) throw AppError.notFound('business_not_found', 'Business was not found.');
  const business = (await pool.query(`SELECT "Id","Name","ContactEmail","CurrencyCode","TimeZoneId","IsActive","CreatedAtUtc","UpdatedAtUtc" FROM "Businesses" WHERE "Id"=$1`, [businessId])).rows[0];
  if (!business) throw AppError.notFound('business_not_found', 'Business was not found.');
  // Counts and the plan are read inside this business's own context: another business's rows can never be added in.
  const usage = await runWithTenantRlsContext(async () => {
    setTenantRlsContext(businessId);
    const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM "Memberships" WHERE "Status" = 0) AS "activeStaff",
      (SELECT count(*)::int FROM "Locations" WHERE "IsActive") AS "locations",
      (SELECT count(*)::int FROM "Customers") AS "customers",
      (SELECT count(*)::int FROM "Orders") AS "orders",
      (SELECT count(*)::int FROM "Orders" WHERE "CreatedAtUtc" >= now() - interval '30 days') AS "ordersLast30Days",
      (SELECT count(*)::int FROM "Invoices") AS "invoices",
      (SELECT COALESCE(sum("SizeBytes"), 0)::bigint FROM "MediaAssets") AS "storageBytes"`)).rows[0];
    const owner = (await pool.query(`SELECT u."Email", u."FullName" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId" WHERE m."IsOwner" LIMIT 1`)).rows[0];
    const plan = (await pool.query(`SELECT p."Code", p."Name", s."Status", s."CurrentPeriodEndUtc" FROM "Subscriptions" s JOIN "Plans" p ON p."Id" = s."PlanId"
      ORDER BY s."CreatedAtUtc" DESC LIMIT 1`)).rows[0];
    return { counts, owner, plan };
  });
  await writeAudit(pool, actorEmail, 'platform.business.viewed', 'Business', businessId, {});
  const c = usage.counts;
  return {
    id: business.Id, name: business.Name, contactEmail: business.ContactEmail, currencyCode: business.CurrencyCode, timeZoneId: business.TimeZoneId,
    isActive: business.IsActive, createdAtUtc: business.CreatedAtUtc, updatedAtUtc: business.UpdatedAtUtc,
    owner: usage.owner ? { email: usage.owner.Email, fullName: usage.owner.FullName } : null,
    plan: usage.plan ? { code: usage.plan.Code, name: usage.plan.Name, status: usage.plan.Status, currentPeriodEndUtc: usage.plan.CurrentPeriodEndUtc } : null,
    usage: { activeStaff: c.activeStaff, locations: c.locations, customers: c.customers, orders: c.orders, ordersLast30Days: c.ordersLast30Days, invoices: c.invoices, storageBytes: Number(c.storageBytes) },
  };
}

export async function lookupPlatformUser(pool, actorEmail, allowlist, email) {
  requirePlatformAdmin(actorEmail, allowlist);
  const address = String(email ?? '').trim();
  if (!address || address.length > 254 || !address.includes('@')) throw AppError.badRequest('invalid_email', 'Enter a full email address.');
  const user = (await pool.query(`SELECT "Id","Email","FullName","EmailConfirmed","TwoFactorEnabled","LockoutEnd","AccessFailedCount","CreatedAtUtc"
    FROM "AspNetUsers" WHERE "NormalizedEmail" = $1`, [address.toUpperCase()])).rows[0];
  // The audit entry never holds the searched address, only whether an account was found and which one.
  await writeAudit(pool, actorEmail, 'platform.user.lookup', 'User', user?.Id ?? null, { found: Boolean(user) });
  if (!user) throw AppError.notFound('user_not_found', 'No account has that email address.');
  const memberships = await runWithTenantRlsContext(async () => {
    setTenantLookup('user_id', user.Id);
    return (await pool.query(`SELECT m."Id", m."BusinessId", m."IsOwner", m."Status", m."DisplayName", b."Name" AS "BusinessName", b."IsActive" AS "BusinessActive"
      FROM "Memberships" m JOIN "Businesses" b ON b."Id" = m."BusinessId" WHERE m."UserId" = $1 ORDER BY m."CreatedAtUtc"`, [user.Id])).rows;
  });
  const lockedUntil = user.LockoutEnd && new Date(user.LockoutEnd) > new Date() ? user.LockoutEnd : null;
  return {
    id: user.Id, email: user.Email, fullName: user.FullName, emailConfirmed: user.EmailConfirmed, twoFactorEnabled: user.TwoFactorEnabled,
    lockedUntilUtc: lockedUntil, failedSignIns: user.AccessFailedCount, createdAtUtc: user.CreatedAtUtc,
    memberships: memberships.map((m) => ({ id: m.Id, businessId: m.BusinessId, businessName: m.BusinessName, businessActive: m.BusinessActive,
      isOwner: m.IsOwner, active: m.Status === 0, displayName: m.DisplayName })),
  };
}

export async function listPlatformAuditLogs(pool, actorEmail, allowlist, { action, actor, from, to, limit, before } = {}) {
  requirePlatformAdmin(actorEmail, allowlist);
  const take = takeFrom(limit);
  const cursor = decodeCursor(before);
  const { rows } = await pool.query(`
    SELECT "Id","ActorEmail","Action","EntityType","EntityId","DetailsJson","CreatedAtUtc" FROM "PlatformAuditLogs"
    WHERE ($1::text IS NULL OR "Action" = $1)
      AND ($2::text IS NULL OR "ActorEmail" = $2)
      AND ($3::timestamptz IS NULL OR "CreatedAtUtc" >= $3::timestamptz)
      AND ($4::timestamptz IS NULL OR "CreatedAtUtc" < $4::timestamptz)
      AND ($5::timestamptz IS NULL OR ("CreatedAtUtc", "Id") < ($5::timestamptz, $6::uuid))
    ORDER BY "CreatedAtUtc" DESC, "Id" DESC LIMIT $7`,
  [action || null, actor ? String(actor).trim().toLowerCase() : null, from || null, to || null, cursor?.t ?? null, cursor?.id ?? null, take + 1]);
  const page = rows.slice(0, take);
  return {
    items: page.map((r) => ({ id: r.Id, actorEmail: r.ActorEmail, action: r.Action, entityType: r.EntityType, entityId: r.EntityId, details: r.DetailsJson ?? {}, createdAtUtc: r.CreatedAtUtc })),
    next: rows.length > take ? encodeCursor(page[page.length - 1]) : null,
  };
}

const isSet = (value) => typeof value === 'string' ? value.trim().length > 0 : Boolean(value);

/** Whether a setting is present, never its value. */
export function configurationFlags(env) {
  return [
    { key: 'paystack', label: 'Paystack (billing and online payments)', set: isSet(env.BILLING_PAYSTACK_SECRET_KEY) },
    { key: 'resend_api', label: 'Resend API key', set: isSet(env.EMAIL_RESEND_API_KEY) },
    { key: 'resend_webhook', label: 'Resend webhook secret', set: isSet(env.EMAIL_RESEND_WEBHOOK_SECRET) },
    { key: 'twilio', label: 'Twilio (SMS)', set: isSet(env.TWILIO_ACCOUNT_SID) && isSet(env.TWILIO_AUTH_TOKEN) },
    { key: 'twilio_inbound', label: 'Twilio inbound address (STOP)', set: isSet(env.TWILIO_INBOUND_WEBHOOK_URL) || isSet(env.PUBLIC_BASE_URL) },
    { key: 'meta_whatsapp', label: 'Meta WhatsApp (sending)', set: isSet(env.META_WHATSAPP_ACCESS_TOKEN) && isSet(env.META_WHATSAPP_PHONE_NUMBER_ID) },
    { key: 'meta_webhook', label: 'Meta WhatsApp webhook (app secret and verify token)', set: isSet(env.META_WHATSAPP_APP_SECRET) && isSet(env.META_WHATSAPP_VERIFY_TOKEN) },
    { key: 's3', label: 'S3 storage', set: env.STORAGE_PROVIDER === 's3' && isSet(env.STORAGE_S3_BUCKET) && isSet(env.STORAGE_S3_ACCESS_KEY) && isSet(env.STORAGE_S3_SECRET_KEY) },
    { key: 'trusted_proxy', label: 'Trusted proxy addresses', set: isSet(env.TRUSTED_PROXY_CIDRS) },
  ];
}

const QUEUES = [
  ['notification', 'NotificationOutbox'], ['push', 'PushDeliveries'], ['worker-summary', 'WorkerSummaryJobs'],
  ['appointment-reminder', 'AppointmentReminders'], ['email', 'EmailOutbox'],
];

export async function getPlatformHealth(pool, env, actorEmail, allowlist) {
  requirePlatformAdmin(actorEmail, allowlist);
  const started = performance.now();
  let database = { ok: false, pingMs: null };
  try { await pool.query('SELECT 1'); database = { ok: true, pingMs: Math.round((performance.now() - started) * 10) / 10 }; } catch { /* reported as not ok */ }
  let migrations = null;
  try {
    const row = (await pool.query('SELECT count(*)::int AS n, max(name) AS latest FROM avzar_schema_migrations')).rows[0];
    migrations = { applied: row.n, latest: row.latest };
  } catch { /* the table may be unreadable for the API role; shown as unknown */ }
  let queues = null;
  try {
    const union = QUEUES.map(([kind, table]) => `SELECT '${kind}'::text AS kind, "Status" AS status, count(*)::int AS n FROM "${table}" GROUP BY "Status"`).join(' UNION ALL ');
    const rows = (await runWithPlatformAdminRead(() => pool.query(union))).rows;
    queues = QUEUES.map(([kind]) => ({ kind, statuses: Object.fromEntries(rows.filter((r) => r.kind === kind).map((r) => [r.status, r.n])) }));
  } catch { /* shown as unknown */ }
  return {
    checkedAtUtc: new Date().toISOString(),
    process: { nodeVersion: process.version, uptimeSeconds: Math.round(process.uptime()), environment: env.NODE_ENV ?? null, emailProvider: env.EMAIL_PROVIDER ?? null, storageProvider: env.STORAGE_PROVIDER ?? null },
    database, migrations, queues, configuration: configurationFlags(env),
  };
}
