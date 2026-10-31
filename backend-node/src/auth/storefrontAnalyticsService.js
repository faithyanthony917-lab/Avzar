import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { withTransaction } from './accountService.js';

/** Must match STOREFRONT_CONSENT_VERSION in web/src/lib/storefront-consent.ts. A visitor's older choice is asked again when this changes. */
export const STOREFRONT_CONSENT_VERSION = 2;
/** A consent token (and the browser-side choice) is valid for this long; after it the visitor is asked again. */
export const CONSENT_TTL_DAYS = 180;
const DAY_MS = 86_400_000;
const SLUG = /^[a-z0-9-]{3,40}$/;
const SUMMARY_DAYS = [7, 30, 90];

const consentSchema = z.object({ version: z.number().int(), decision: z.enum(['accepted', 'rejected']), consentToken: z.string().max(300).optional() }).strict();
const eventSchema = z.object({ type: z.literal('page_view'), path: z.string().max(400), consentToken: z.string().max(200) }).strict();
const settingsSchema = z.object({ enabled: z.boolean() }).strict();

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

// ---- consent token -------------------------------------------------------------------------------------------------------------
// Each acceptance receives a unique, signed token. Only its SHA-256 hash is stored, allowing a later rejection to revoke that
// grant server-side without storing a visitor id, IP address, user agent, referrer or raw consent token.
const keyFor = (secret) => createHmac('sha256', String(secret)).update('avzar:storefront-analytics:v1').digest();
const sign = (secret, storefrontId, version, expiresAtSeconds, nonce) =>
  createHmac('sha256', keyFor(secret)).update(`${storefrontId}|${version}|${expiresAtSeconds}|${nonce}`).digest('base64url');
export const consentTokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

export function issueConsentToken(secret, storefrontId, version = STOREFRONT_CONSENT_VERSION, now = new Date()) {
  const expiresAtSeconds = Math.floor(now.getTime() / 1000) + CONSENT_TTL_DAYS * 86_400;
  const nonce = randomBytes(16).toString('base64url');
  return `${version}.${expiresAtSeconds}.${nonce}.${sign(secret, storefrontId, version, expiresAtSeconds, nonce)}`;
}

export function verifyConsentToken(secret, token, storefrontId, now = new Date()) {
  const match = /^(\d{1,4})\.(\d{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!match) return false;
  const version = Number(match[1]);
  const expiresAtSeconds = Number(match[2]);
  const nonce = match[3];
  if (version !== STOREFRONT_CONSENT_VERSION || expiresAtSeconds * 1000 <= now.getTime()) return false;
  const expected = Buffer.from(sign(secret, storefrontId, version, expiresAtSeconds, nonce));
  const supplied = Buffer.from(match[4]);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

// ---- paths ---------------------------------------------------------------------------------------------------------------------
/** A storefront-relative path such as "/", "/about" or "/design/silk-gown". Query strings and fragments are dropped. Returns null if unusable. */
export function normalizeAnalyticsPath(raw) {
  if (typeof raw !== 'string') return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  if (!withoutQuery.startsWith('/') || withoutQuery.startsWith('//')) return null;
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
  const lower = (trimmed || '/').toLowerCase();
  if (lower.length > 200 || !/^\/[a-z0-9\-._~/]*$/.test(lower)) return null;
  const segments = lower.split('/').filter(Boolean);
  if (segments.length > 4 || segments.some((segment) => segment === '.' || segment === '..' || segment.length > 80)) return null;
  return lower;
}

// ---- storefront lookup ---------------------------------------------------------------------------------------------------------
async function resolveStorefront(pool, slug) {
  if (!SLUG.test(String(slug ?? ''))) throw AppError.notFound('site_not_found', 'This site does not exist.');
  // The settings row is tenant data, so bind the storefront's business (found by slug) before joining it.
  await bindTenantByLookup(pool, 'storefront_slug', slug);
  const { rows } = await pool.query(
    `SELECT s."Id", s."BusinessId", a."Enabled" AS "StorefrontAnalyticsEnabled"
     FROM "Storefronts" s LEFT JOIN "StorefrontAnalyticsSettings" a ON a."BusinessId" = s."BusinessId"
     WHERE s."Slug" = $1 AND s."Status" = 'Published'`, [slug]);
  const row = rows[0];
  if (!row) throw AppError.notFound('site_not_found', 'This site does not exist.');
  return { storefrontId: row.Id, businessId: row.BusinessId, enabled: row.StorefrontAnalyticsEnabled === true };
}

// ---- visitor-facing ------------------------------------------------------------------------------------------------------------
/** Records an anonymous consent decision. Nothing is recorded while the business has analytics switched off. */
export async function recordConsentDecision({ pool, provider, secret, now = new Date() }, slug, body) {
  const request = parse(consentSchema, body);
  if (request.version !== STOREFRONT_CONSENT_VERSION) {
    throw AppError.badRequest('consent_version_mismatch', 'This privacy choice is out of date. Reload the page and choose again.');
  }
  const site = await resolveStorefront(pool, slug);
  const priorTokenHash = request.consentToken ? consentTokenHash(request.consentToken) : null;
  if (request.decision === 'rejected' && priorTokenHash) {
    // Revoke even while the owner has analytics switched off, so an old grant cannot revive if analytics is enabled later.
    await provider.revokeConsentToken({ businessId: site.businessId, storefrontId: site.storefrontId, tokenHash: priorTokenHash, now });
  }
  if (!site.enabled) return { recorded: false, analyticsEnabled: false };
  if (request.decision === 'accepted') {
    const consentToken = issueConsentToken(secret, site.storefrontId, request.version, now);
    const expiresAt = new Date(now.getTime() + CONSENT_TTL_DAYS * DAY_MS);
    await provider.recordConsent({ businessId: site.businessId, storefrontId: site.storefrontId, version: request.version, decision: request.decision, tokenHash: consentTokenHash(consentToken), expiresAt });
    return { recorded: true, analyticsEnabled: true, consentToken };
  }
  await provider.recordConsent({ businessId: site.businessId, storefrontId: site.storefrontId, version: request.version, decision: request.decision });
  return { recorded: true, analyticsEnabled: true };
}

/** Counts one page view. It needs the business switch ON and a valid consent token for this storefront; otherwise nothing is stored. */
export async function recordPageView({ pool, provider, secret, now = new Date() }, slug, body) {
  const request = parse(eventSchema, body);
  const path = normalizeAnalyticsPath(request.path);
  if (!path) throw AppError.badRequest('invalid_path', 'The page path is not valid.');
  const site = await resolveStorefront(pool, slug);
  if (!site.enabled) return { collected: false, reason: 'analytics_disabled' };
  if (!verifyConsentToken(secret, request.consentToken, site.storefrontId, now) ||
      !(await provider.isConsentTokenActive({ businessId: site.businessId, storefrontId: site.storefrontId, tokenHash: consentTokenHash(request.consentToken), now }))) {
    throw AppError.forbidden('consent_required', 'Analytics consent is missing, expired, revoked or not valid for this site. Nothing was collected.');
  }
  await provider.recordPageView({ businessId: site.businessId, storefrontId: site.storefrontId, day: isoDay(now), path });
  return { collected: true };
}

// ---- owner-facing --------------------------------------------------------------------------------------------------------------
export async function getAnalyticsSettings(pool, user) {
  const { rows } = await pool.query('SELECT "Enabled" FROM "StorefrontAnalyticsSettings" WHERE "BusinessId" = $1', [user.businessId]);
  return { enabled: rows[0]?.Enabled === true, consentVersion: STOREFRONT_CONSENT_VERSION };
}

export async function setAnalyticsEnabled(pool, user, body) {
  const { enabled } = parse(settingsSchema, body);
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO "StorefrontAnalyticsSettings" ("BusinessId", "Enabled", "UpdatedAtUtc") VALUES ($1, $2, now())
       ON CONFLICT ("BusinessId") DO UPDATE SET "Enabled" = EXCLUDED."Enabled", "UpdatedAtUtc" = now()`, [user.businessId, enabled]);
    await tx.query(
      `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
       VALUES ($1,$2,$3,$4,now(),$5::jsonb,$6,$7)`,
      [randomUUID(), enabled ? 'storefront_analytics.enabled' : 'storefront_analytics.disabled', user.userId, user.businessId, JSON.stringify({ enabled }), user.businessId, 'Business']);
  });
  return { enabled, consentVersion: STOREFRONT_CONSENT_VERSION };
}

export async function getAnalyticsSummary({ pool, provider, now = new Date() }, user, query = {}) {
  const days = query.days === undefined ? 30 : Number.parseInt(String(query.days), 10);
  if (!SUMMARY_DAYS.includes(days)) throw AppError.badRequest('invalid_days', 'days must be 7, 30 or 90.');
  const { rows: storefronts } = await pool.query('SELECT "Id", "Name", "Slug" FROM "Storefronts" WHERE "BusinessId" = $1 ORDER BY "Name"', [user.businessId]);
  let storefrontId = null;
  if (query.storefrontId !== undefined && query.storefrontId !== '') {
    if (!z.string().uuid().safeParse(String(query.storefrontId)).success) throw AppError.badRequest('invalid_storefront_id', 'The storefrontId is invalid.');
    if (!storefronts.some((row) => row.Id === String(query.storefrontId))) throw AppError.notFound('storefront_not_found', 'This storefront was not found.');
    storefrontId = String(query.storefrontId);
  }
  const toDay = isoDay(now);
  const fromDay = isoDay(new Date(now.getTime() - (days - 1) * DAY_MS));
  const [settings, data] = await Promise.all([
    getAnalyticsSettings(pool, user),
    provider.summary({ businessId: user.businessId, storefrontId, fromDay, toDay }),
  ]);
  const byDay = new Map(data.daily.map((entry) => [entry.day, entry.views]));
  const daily = Array.from({ length: days }, (_, index) => {
    const day = isoDay(new Date(now.getTime() - (days - 1 - index) * DAY_MS));
    return { day, views: byDay.get(day) ?? 0 };
  });
  return {
    enabled: settings.enabled, days, fromDay, toDay,
    storefronts: storefronts.map((row) => ({ id: row.Id, name: row.Name, slug: row.Slug })),
    storefrontId,
    totalViews: daily.reduce((sum, entry) => sum + entry.views, 0),
    daily, topPaths: data.topPaths, consent: data.consent,
  };
}
