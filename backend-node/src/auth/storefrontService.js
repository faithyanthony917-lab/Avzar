import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { AppError } from '../http/errors.js';
import { adoptTenant, setTenantLookup } from '../db/tenantRlsContext.js';
import { ensureBelowLimit, entitlementValue, requireFlag, requireTier } from './entitlementService.js';
import { withTransaction } from './accountService.js';
import { rethrowSlugTaken, withStorefrontSlugVisible } from './storefrontSlugCheck.js';
import { resolveTheme } from './publicSiteRoutes.js';
import { missingWorkflowEntryPoints, parseStorefrontDocument, validateStorefrontDocument } from './storefrontDocument.js';
import { storefrontDocumentCatalog } from './storefrontDocument.js';
import { sampleTemplateKeys, starterDocument } from './storefrontStarters.js';
import { structureChanges } from './storefrontContentOnly.js';
import { windowedRows } from './listWindow.js';

const templateTiers = new Map([
  ['standard', 'standard'], ['bespoke', 'basic'], ['ready-to-wear', 'basic'], ['luxury', 'advanced'],
  ['african-heritage', 'advanced'], ['bridal', 'advanced'], ['streetwear', 'premium'], ['atelier-studio', 'premium'],
]);
const reservedSlugs = new Set(['www', 'api', 'admin', 'app', 'mail', 'static', 'assets', 'cdn', 'public', 'dashboard', 'login', 'support', 'help', 'status', 'blog', 'docs', 'preview']);
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const contrastPairs = [
  ['text', 'background', 4.5], ['heading', 'background', 3], ['text', 'card', 4.5],
  ['buttonText', 'button', 4.5], ['navText', 'nav', 4.5], ['footerText', 'footer', 4.5],
];

function contrastRatio(first, second) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function blendColor(color, toward, amount) {
  return `#${[1, 3, 5].map((offset) => {
    const start = Number.parseInt(color.slice(offset, offset + 2), 16);
    const end = Number.parseInt(toward.slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * amount).toString(16).padStart(2, '0');
  }).join('')}`.toUpperCase();
}

function suggestForeground(foreground, background, target) {
  if (contrastRatio(foreground, background) >= target) return foreground;
  for (let step = 1; step <= 20; step += 1) {
    const amount = step * 0.05;
    const candidates = ['#000000', '#FFFFFF'].map((color) => blendColor(foreground, color, amount))
      .filter((color) => contrastRatio(color, background) >= target)
      .sort((first, second) => contrastRatio(second, background) - contrastRatio(first, background));
    if (candidates.length) return candidates[0];
  }
  return contrastRatio('#000000', background) >= contrastRatio('#FFFFFF', background) ? '#000000' : '#FFFFFF';
}

function getContrastWarnings(document) {
  const colors = resolveTheme(document.theme).colors;
  return contrastPairs.flatMap(([foreground, background, required]) => {
    const foregroundHex = colors[foreground];
    const backgroundHex = colors[background];
    if (!foregroundHex || !backgroundHex) return [];
    const ratio = contrastRatio(foregroundHex, backgroundHex);
    return ratio < required ? [{ foreground, background, foregroundHex, backgroundHex,
      ratio: Math.round(ratio * 100) / 100, required,
      suggestedForegroundHex: suggestForeground(foregroundHex, backgroundHex, required) }] : [];
  });
}

/** The document a new site starts with. Kept as the single entry point; the layouts live in `storefrontStarters.js`. */
export function defaultDocument(name, templateKey = 'standard') {
  return starterDocument(name, templateKey);
}

function mapSummary(row) {
  return {
    id: row.Id, name: row.Name, slug: row.Slug, status: row.Status, templateKey: row.TemplateKey,
    publishedVersion: row.PublishedVersion, draftRevision: row.DraftRevision,
    hasUnpublishedChanges: row.HasUnpublishedChanges, updatedAtUtc: row.UpdatedAtUtc,
  };
}

function mapDetails(row, baseDomain) {
  return {
    ...mapSummary(row), contactEmail: row.ContactEmail, contactPhone: row.ContactPhone, address: row.Address,
    openingHours: row.OpeningHours, workflowInquiry: row.WorkflowInquiry, workflowBooking: row.WorkflowBooking,
    workflowCustomOrder: row.WorkflowCustomOrder, workflowContact: row.WorkflowContact,
    allowSearchIndexing: row.AllowSearchIndexing, version: Number(row.Version), publicUrlPath: `https://${row.Slug}.${baseDomain}`,
  };
}

async function lockStorefrontSlugs(db, slugs) {
  for (const slug of [...new Set(slugs)].sort()) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`storefront-slug:${slug}`]);
  }
}

const listSql = `SELECT s."Id", s."Name", s."Slug", s."Status", s."TemplateKey", s."DraftRevision",
  s.xmin::text::bigint AS "Version",
  s."CreatedAtUtc", COALESCE(s."UpdatedAtUtc", s."CreatedAtUtc") AS "UpdatedAtUtc",
  v."VersionNumber" AS "PublishedVersion",
  (s."PublishedVersionId" IS NULL OR s."DraftJson"::jsonb IS DISTINCT FROM v."DocumentJson") AS "HasUnpublishedChanges"
  FROM "Storefronts" s LEFT JOIN "StorefrontVersions" v ON v."Id" = s."PublishedVersionId" AND v."BusinessId" = s."BusinessId"`;

async function loadOwned(db, user, id, lock = false) {
  const { rows } = await db.query(
    `${listSql} WHERE s."Id" = $1 AND s."BusinessId" = $2${lock ? ' FOR UPDATE OF s' : ''}`,
    [id, user.businessId]);
  if (!rows[0]) throw AppError.notFound('storefront_not_found', 'Site not found.');
  return rows[0];
}

async function audit(db, user, action, id, details = null) {
  await db.query(
    `INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
     VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'Storefront')`,
    [randomUUID(), action, user.userId, user.businessId, details ? JSON.stringify(details) : null, id]);
}

function makeSlug(requested, name) {
  if (requested?.trim()) {
    const slug = requested.trim().toLowerCase();
    if (slug.length < 3 || slug.length > 40 || !/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(slug) || slug.includes('--')) {
      throw AppError.badRequest('invalid_slug', 'Use 3-40 lowercase letters, digits and single dashes.');
    }
    if (reservedSlugs.has(slug)) throw AppError.badRequest('reserved_slug', 'That address is reserved.');
    return slug;
  }
  let slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34).replace(/-$/g, '');
  if (slug.length < 3) slug = `${slug || 'shop'}-shop`;
  if (reservedSlugs.has(slug)) slug = `${slug}-studio`;
  return slug;
}

export async function listStorefronts(pool, user) {
  const { rows } = await pool.query(`${listSql} WHERE s."BusinessId" = $1 ORDER BY s."CreatedAtUtc"`, [user.businessId]);
  return rows.map(mapSummary);
}

export async function getStorefront(pool, user, id, baseDomain) {
  return mapDetails(await loadOwned(pool, user, id), baseDomain);
}

export async function createStorefront(pool, user, request, baseDomain) {
  const name = request.name.trim();
  const templateTier = templateTiers.get(request.templateKey);
  if (!templateTier) throw AppError.badRequest('unknown_template', 'That template does not exist.');
  await requireTier(pool, user.businessId, 'storefront.template_tier', templateTier);
  const doc = defaultDocument(name, request.templateKey);
  const id = randomUUID();
  return withTransaction(pool, async (client) => {
    await ensureBelowLimit(client, user.businessId, 'storefront.count.max', async (db) => {
      const result = await db.query('SELECT count(*)::bigint AS "Count" FROM "Storefronts" WHERE "BusinessId" = $1', [user.businessId]);
      return Number(result.rows[0].Count);
    });
    const slug = makeSlug(request.slug, name);
    await lockStorefrontSlugs(client, [slug]);
    const { rows: conflicts } = await withStorefrontSlugVisible(client, slug, () => client.query(`
      SELECT 1 FROM "Storefronts" WHERE "Slug" = $1
      UNION ALL SELECT 1 FROM "StorefrontSlugRedirects" WHERE "OldSlug" = $1 LIMIT 1`, [slug]));
    if (conflicts.length) throw AppError.conflict('slug_taken', 'That web address is already taken. Choose another.');
    await client.query(
      `INSERT INTO "Storefronts" ("Id", "BusinessId", "Name", "Slug", "TemplateKey", "DraftJson", "DraftRevision", "Status", "PublishedVersionId", "ContactEmail", "ContactPhone", "Address", "OpeningHours", "WorkflowInquiry", "WorkflowBooking", "WorkflowCustomOrder", "WorkflowContact", "AllowSearchIndexing", "CreatedAtUtc")
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'Draft', NULL, NULL, NULL, NULL, NULL, TRUE, FALSE, FALSE, TRUE, TRUE, now())`,
      [id, user.businessId, name, slug, request.templateKey, JSON.stringify(doc)]).catch(rethrowSlugTaken);
    await audit(client, user, 'storefront.created', id, { slug, template: request.templateKey });
    return mapDetails(await loadOwned(client, user, id), baseDomain);
  });
}

export async function updateStorefrontSettings(pool, user, id, request, baseDomain) {
  const name = request.name.trim();
  for (const text of [name, request.contactPhone, request.address, request.openingHours].filter(Boolean)) {
    if (text.includes('<') || text.includes('>')) throw AppError.badRequest('invalid_text', 'The characters < and > are not allowed.');
  }
  if (request.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.contactEmail)) {
    throw AppError.badRequest('invalid_email', 'Enter a valid email address.');
  }
  return withTransaction(pool, async (client) => {
    const current = await loadOwned(client, user, id, true);
    if (Number(current.Version) !== request.version) throw AppError.conflict('stale_version', 'This site was changed by someone else. Reload and try again.');
    const { rowCount } = await client.query(
      `UPDATE "Storefronts" SET "Name" = $3, "ContactEmail" = $4, "ContactPhone" = $5, "Address" = $6, "OpeningHours" = $7,
       "WorkflowInquiry" = $8, "WorkflowBooking" = $9, "WorkflowCustomOrder" = $10, "WorkflowContact" = $11,
       "AllowSearchIndexing" = $12, "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "BusinessId" = $2 AND xmin::text::bigint = $13`,
      [id, user.businessId, name, clean(request.contactEmail), clean(request.contactPhone), clean(request.address), clean(request.openingHours),
        request.workflowInquiry, request.workflowBooking, request.workflowCustomOrder, request.workflowContact, request.allowSearchIndexing, request.version]);
    if (rowCount !== 1) throw AppError.conflict('stale_version', 'This site was changed by someone else. Reload and try again.');
    await audit(client, user, 'storefront.settings_changed', id);
    return mapDetails(await loadOwned(client, user, id), baseDomain);
  });
}

export async function updateStorefrontSlug(pool, user, id, request, baseDomain) {
  return withTransaction(pool, async (client) => {
    const current = await loadOwned(client, user, id, true);
    if (Number(current.Version) !== request.version) throw AppError.conflict('stale_version', 'This site was changed by someone else. Reload and try again.');
    const slug = makeSlug(request.slug, current.Name);
    if (slug === current.Slug) return mapDetails(current, baseDomain);

    await lockStorefrontSlugs(client, [current.Slug, slug]);
    const { conflicts, redirectRows } = await withStorefrontSlugVisible(client, slug, async () => ({
      conflicts: (await client.query('SELECT 1 FROM "Storefronts" WHERE "Slug" = $1', [slug])).rows,
      redirectRows: (await client.query('SELECT 1 FROM "StorefrontSlugRedirects" WHERE "OldSlug" = $1', [slug])).rows,
    }));
    if (conflicts.length || redirectRows.length) {
      throw AppError.conflict('slug_taken', 'That web address is already taken. Choose another.');
    }
    await client.query(`
      INSERT INTO "StorefrontSlugRedirects" ("OldSlug", "StorefrontId", "BusinessId", "CreatedAtUtc")
      VALUES ($1, $2, $3, now())`, [current.Slug, id, user.businessId]).catch(rethrowSlugTaken);
    const { rowCount } = await client.query(`
      UPDATE "Storefronts" SET "Slug" = $3, "UpdatedAtUtc" = now()
      WHERE "Id" = $1 AND "BusinessId" = $2 AND xmin::text::bigint = $4`,
    [id, user.businessId, slug, request.version]).catch(rethrowSlugTaken);
    if (rowCount !== 1) throw AppError.conflict('stale_version', 'This site was changed by someone else. Reload and try again.');
    await audit(client, user, 'storefront.slug_changed', id, { oldSlug: current.Slug, newSlug: slug });
    return mapDetails(await loadOwned(client, user, id), baseDomain);
  });
}

function previewSignature(key, payload) {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/**
 * `sampleTemplate` (optional) asks for a sample of that template with the shop's own name instead of the saved draft. It is view only and
 * needs no plan tier, so an owner can see a locked template before upgrading; saving, switching and publishing still check the tier.
 */
export async function createPreviewLink(pool, env, user, id, sampleTemplate = null) {
  if (sampleTemplate !== null && !sampleTemplateKeys.includes(sampleTemplate)) {
    throw AppError.badRequest('template_not_previewable', 'A sample is not available for that template.');
  }
  await loadOwned(pool, user, id);
  const key = env.JWT_SIGNING_KEY;
  if (!key || key.length < 32) throw new AppError(503, 'preview_not_configured', 'Preview links are not configured on this server.');
  const expiresAtUtc = new Date(Date.now() + Number(env.STOREFRONT_PREVIEW_MINUTES ?? 30) * 60_000);
  const payload = Buffer.from(JSON.stringify(sampleTemplate ? { id, exp: expiresAtUtc.getTime(), t: sampleTemplate } : { id, exp: expiresAtUtc.getTime() })).toString('base64url');
  return { token: `${payload}.${previewSignature(key, payload)}`, expiresAtUtc: expiresAtUtc.toISOString() };
}

function readPreviewToken(env, token) {
  const key = env.JWT_SIGNING_KEY;
  if (!key || key.length < 32) throw new AppError(503, 'preview_not_configured', 'Preview links are not configured on this server.');
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra !== undefined) throw AppError.notFound('preview_expired', 'This preview link has expired. Open the preview again from the builder.');
  const expected = Buffer.from(previewSignature(key, payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw AppError.notFound('preview_expired', 'This preview link has expired. Open the preview again from the builder.');
  }
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof value.id !== 'string' || !Number.isFinite(value.exp) || value.exp <= Date.now()) throw new Error('expired');
    if (value.t !== undefined && !sampleTemplateKeys.includes(value.t)) throw new Error('unknown sample');
    return { id: value.id, sampleTemplate: value.t ?? null };
  } catch {
    throw AppError.notFound('preview_expired', 'This preview link has expired. Open the preview again from the builder.');
  }
}

export async function getPreviewSite(pool, env, token) {
  const { id, sampleTemplate } = readPreviewToken(env, token);
  // The signed preview token names the storefront; the storefront row then names the business.
  setTenantLookup('storefront_id', id);
  const { rows } = await pool.query(
    `SELECT s."Id", s."BusinessId", s."Name", s."Slug", s."DraftJson", s."ContactEmail", s."ContactPhone", s."Address", s."OpeningHours",
            s."WorkflowInquiry", s."WorkflowBooking", s."WorkflowCustomOrder", s."WorkflowContact", b."Name" AS "BusinessName", b."CurrencyCode"
     FROM "Storefronts" s JOIN "Businesses" b ON b."Id" = s."BusinessId" WHERE s."Id" = $1`, [id]);
  const site = rows[0];
  if (!site) throw AppError.notFound('site_not_found', 'This site does not exist.');
  adoptTenant(site.BusinessId);
  let document;
  if (sampleTemplate) document = starterDocument(site.Name, sampleTemplate);
  else {
    try { document = typeof site.DraftJson === 'string' ? JSON.parse(site.DraftJson) : structuredClone(site.DraftJson); }
    catch { throw new AppError(500, 'invalid_storefront_document', 'The saved storefront draft could not be read.'); }
  }
  document.archive = [];
  document.pages = (document.pages ?? []).filter((page) => page.visible).map((page) => ({
    ...page, sections: (page.sections ?? []).filter((section) => section.visible),
  }));
  const visiblePages = new Set(document.pages.map((page) => page.id));
  document.navigation = (document.navigation ?? []).filter((item) => item.visible && visiblePages.has(item.pageId));
  const preset = document.theme?.preset ?? 'clean-professional';
  return {
    name: site.Name, slug: site.Slug, businessName: site.BusinessName, currencyCode: site.CurrencyCode,
    templateKey: document.templateKey, versionNumber: 0, isPreview: true, isSample: Boolean(sampleTemplate), document,
    theme: resolveTheme(document.theme),
    contact: { email: site.ContactEmail, phone: site.ContactPhone, address: site.Address, openingHours: site.OpeningHours },
    workflows: [site.WorkflowInquiry && 'inquiry', site.WorkflowBooking && 'booking', site.WorkflowCustomOrder && 'customOrder', site.WorkflowContact && 'contact'].filter(Boolean),
    allowSearchIndexing: false,
  };
}

function domainDto(domain) {
  return {
    id: domain.Id, hostname: domain.Hostname, status: domain.Status,
    verificationRecordName: `_avzar-verify.${domain.Hostname}`, verificationRecordValue: domain.VerificationToken,
    verifiedAtUtc: domain.VerifiedAtUtc, lastCheckedAtUtc: domain.LastCheckedAtUtc, lastError: domain.LastError,
  };
}

async function requireOwnedStorefront(pool, user, storefrontId) {
  const { rows } = await pool.query(
    `SELECT "Id" FROM "Storefronts" WHERE "Id" = $1 AND "BusinessId" = $2`, [storefrontId, user.businessId]);
  if (!rows[0]) throw AppError.notFound('storefront_not_found', 'Site not found.');
}

export async function listStorefrontDomains(pool, user, storefrontId) {
  await requireOwnedStorefront(pool, user, storefrontId);
  const { rows } = await pool.query(
    `SELECT "Id", "Hostname", "Status", "VerificationToken", "VerifiedAtUtc", "LastCheckedAtUtc", "LastError"
     FROM "StorefrontDomains" WHERE "StorefrontId" = $1 AND "BusinessId" = $2 ORDER BY "CreatedAtUtc"`,
    [storefrontId, user.businessId]);
  return rows.map(domainDto);
}

export async function addStorefrontDomain(pool, user, storefrontId, request, baseDomain) {
  await requireFlag(pool, user.businessId, 'storefront.custom_domain');
  await requireOwnedStorefront(pool, user, storefrontId);
  const hostname = request.hostname.trim().replace(/\.+$/, '').toLowerCase();
  if (hostname.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(hostname)) {
    throw AppError.badRequest('invalid_hostname', 'Enter a domain like shop.example.com (no http://, no path).');
  }
  const base = String(baseDomain).toLowerCase();
  if (hostname === base || hostname.endsWith(`.${base}`)) {
    throw AppError.badRequest('reserved_hostname', `Domains under ${base} are managed by Avzar.`);
  }
  const { rows: current } = await pool.query(
    `SELECT count(*)::int AS "Count" FROM "StorefrontDomains" WHERE "StorefrontId" = $1 AND "BusinessId" = $2`, [storefrontId, user.businessId]);
  if (current[0].Count >= 3) throw AppError.conflict('too_many_domains', 'A site can have up to 3 custom domains.');
  const { rows: existing } = await pool.query('SELECT 1 FROM "StorefrontDomains" WHERE "Hostname" = $1', [hostname]);
  if (existing.length) throw AppError.conflict('domain_taken', 'That domain is already connected to a site.');
  const domain = {
    id: randomUUID(), hostname, status: 'Pending', verificationRecordName: `_avzar-verify.${hostname}`,
    verificationRecordValue: randomBytes(16).toString('hex'), verifiedAtUtc: null, lastCheckedAtUtc: null, lastError: null,
  };
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO "StorefrontDomains" ("Id", "BusinessId", "StorefrontId", "Hostname", "VerificationToken", "Status", "CreatedAtUtc")
       VALUES ($1, $2, $3, $4, $5, 'Pending', now())`, [domain.id, user.businessId, storefrontId, hostname, domain.verificationRecordValue]);
    await audit(client, user, 'storefront.domain_added', domain.id, { hostname });
  });
  return domain;
}

export async function verifyStorefrontDomain(pool, user, storefrontId, domainId, dnsLookup = resolveTxt) {
  await requireOwnedStorefront(pool, user, storefrontId);
  const { rows } = await pool.query(
    `SELECT "Id", "Hostname", "Status", "VerificationToken", "VerifiedAtUtc", "LastCheckedAtUtc", "LastError"
     FROM "StorefrontDomains" WHERE "Id" = $1 AND "StorefrontId" = $2 AND "BusinessId" = $3`, [domainId, storefrontId, user.businessId]);
  const domain = rows[0];
  if (!domain) throw AppError.notFound('domain_not_found', 'Domain not found.');
  if (domain.LastCheckedAtUtc && Date.now() - new Date(domain.LastCheckedAtUtc).getTime() < 20_000) {
    throw AppError.conflict('too_soon', 'Wait a few seconds before checking again. DNS changes can also take time to spread.');
  }

  let records = [];
  let lastError = null;
  try { records = (await dnsLookup(`_avzar-verify.${domain.Hostname}`)).map((parts) => Array.isArray(parts) ? parts.join('') : parts); }
  catch { lastError = 'The DNS lookup failed. Try again in a minute.'; }
  const found = records.some((record) => record.trim().replace(/^"|"$/g, '').toLowerCase() === domain.VerificationToken.toLowerCase());
  const status = found ? 'Verified' : 'Failed';
  const error = found ? null : lastError ?? 'We could not find the verification record yet.';
  const updated = await withTransaction(pool, async (client) => {
    const { rows: result } = await client.query(
      `UPDATE "StorefrontDomains" SET "Status" = $4, "LastCheckedAtUtc" = now(), "VerifiedAtUtc" = CASE WHEN $4 = 'Verified' THEN now() ELSE "VerifiedAtUtc" END,
         "LastError" = $5, "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "StorefrontId" = $2 AND "BusinessId" = $3
       RETURNING "Id", "Hostname", "Status", "VerificationToken", "VerifiedAtUtc", "LastCheckedAtUtc", "LastError"`,
      [domainId, storefrontId, user.businessId, status, error]);
    if (found) await audit(client, user, 'storefront.domain_verified', domainId, { hostname: domain.Hostname });
    return result[0];
  });
  return domainDto(updated);
}

export async function removeStorefrontDomain(pool, user, storefrontId, domainId) {
  await requireOwnedStorefront(pool, user, storefrontId);
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `DELETE FROM "StorefrontDomains" WHERE "Id" = $1 AND "StorefrontId" = $2 AND "BusinessId" = $3 RETURNING "Hostname"`,
      [domainId, storefrontId, user.businessId]);
    if (!rows[0]) throw AppError.notFound('domain_not_found', 'Domain not found.');
    await audit(client, user, 'storefront.domain_removed', domainId, { hostname: rows[0].Hostname });
  });
}

async function loadDraft(db, user, storefrontId, lock = false) {
  const { rows } = await db.query(
    `SELECT "Id", "BusinessId", "Name", "Slug", "TemplateKey", "DraftJson", "DraftRevision", "Status", "PublishedVersionId",
       "ContactEmail", "ContactPhone", "Address", "OpeningHours", "WorkflowInquiry", "WorkflowBooking", "WorkflowCustomOrder", "WorkflowContact", "AllowSearchIndexing"
     FROM "Storefronts" WHERE "Id" = $1 AND "BusinessId" = $2${lock ? ' FOR UPDATE' : ''}`,
    [storefrontId, user.businessId]);
  if (!rows[0]) throw AppError.notFound('storefront_not_found', 'Site not found.');
  return rows[0];
}

async function draftDto(pool, row, document) {
  const validation = await validateStorefrontDocument(pool, row.BusinessId, document);
  return { storefrontId: row.Id, revision: row.DraftRevision, document, theme: resolveTheme(document.theme),
    contrastWarnings: getContrastWarnings(document), planIssues: validation.planIssues };
}

export async function getStorefrontDraft(pool, user, storefrontId) {
  const row = await loadDraft(pool, user, storefrontId);
  const document = parseStorefrontDocument(row.DraftJson);
  return draftDto(pool, row, document);
}

export async function saveStorefrontDraft(pool, user, storefrontId, request) {
  const current = await loadDraft(pool, user, storefrontId);
  if (current.DraftRevision !== request.expectedRevision) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
  const previous = parseStorefrontDocument(current.DraftJson);
  const document = parseStorefrontDocument(request.document);
  // Every plan may edit the content of the sections it already has. Only the visual builder plans may change the
  // structure (pages, sections, order, layouts, visibility, section styling, menu, template).
  const builder = await entitlementValue(pool, user.businessId, 'storefront.builder', 'false') === 'true';
  if (!builder) {
    const changes = structureChanges(previous, document);
    if (changes.length) {
      throw AppError.forbidden('feature_not_in_plan',
        `${changes[0].message} Your plan lets you edit text, images and contact details; upgrade to change the structure of the site.`,
        { entitlement: 'storefront.builder', contentOnly: true, changes: changes.slice(0, 20) });
    }
  }
  const validation = await validateStorefrontDocument(pool, user.businessId, document, { previous });
  const nextRevision = current.DraftRevision + 1;
  const saved = await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE "Storefronts" SET "DraftJson" = $3, "TemplateKey" = $4, "DraftRevision" = "DraftRevision" + 1, "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "BusinessId" = $2 AND "DraftRevision" = $5`,
      [storefrontId, user.businessId, JSON.stringify(document), document.templateKey, request.expectedRevision]);
    if (rowCount !== 1) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
    await audit(client, user, 'storefront.draft_saved', storefrontId, { revision: nextRevision });
    return loadDraft(client, user, storefrontId);
  });
  return { storefrontId, revision: saved.DraftRevision, document, theme: resolveTheme(document.theme),
    contrastWarnings: getContrastWarnings(document), planIssues: validation.planIssues };
}

export async function saveStorefrontAppearance(pool, user, storefrontId, request) {
  const current = await loadDraft(pool, user, storefrontId);
  if (current.DraftRevision !== request.expectedRevision) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
  const previous = parseStorefrontDocument(current.DraftJson);
  if (!request.theme || typeof request.theme !== 'object' || Array.isArray(request.theme)
      || !request.branding || typeof request.branding !== 'object' || Array.isArray(request.branding)) {
    throw AppError.badRequest('invalid_document', 'The theme or branding could not be read.');
  }
  const document = { ...previous, theme: request.theme, branding: request.branding };
  const validation = await validateStorefrontDocument(pool, user.businessId, document, { previous, checkCollectionsAndCategories: false });
  const nextRevision = current.DraftRevision + 1;
  const saved = await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE "Storefronts" SET "DraftJson" = $3, "DraftRevision" = "DraftRevision" + 1, "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "BusinessId" = $2 AND "DraftRevision" = $4`,
      [storefrontId, user.businessId, JSON.stringify(document), request.expectedRevision]);
    if (rowCount !== 1) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
    await audit(client, user, 'storefront.appearance_saved', storefrontId, { revision: nextRevision });
    return loadDraft(client, user, storefrontId);
  });
  return { storefrontId, revision: saved.DraftRevision, document, theme: resolveTheme(document.theme),
    contrastWarnings: getContrastWarnings(document), planIssues: validation.planIssues };
}

function enabledWorkflows(site) {
  return [site.WorkflowInquiry && 'inquiry', site.WorkflowBooking && 'booking', site.WorkflowCustomOrder && 'customOrder', site.WorkflowContact && 'contact'].filter(Boolean);
}

async function publishDocument(pool, user, site, document, note, rolledBackFromVersion = null,
  { updateDraft = false, checkCollectionsAndCategories = true } = {}) {
  const validation = await validateStorefrontDocument(pool, user.businessId, document, { publish: true, checkCollectionsAndCategories });
  const missing = missingWorkflowEntryPoints(document, enabledWorkflows(site));
  if (missing.length) {
    const labels = { inquiry: 'design inquiries', booking: 'appointment booking', customOrder: 'custom orders', contact: 'contact' };
    throw AppError.conflict('missing_entry_points', `Customers could not reach: ${missing.map((item) => labels[item] ?? item).join(', ')}. Add the matching section to a visible page, or switch that workflow off in the site settings.`, { workflows: missing });
  }
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`storefront-publish:${site.Id.replaceAll('-', '')}`]);
    const { rows: current } = await client.query('SELECT COALESCE(max("VersionNumber"), 0)::int AS "MaxVersion" FROM "StorefrontVersions" WHERE "StorefrontId" = $1 AND "BusinessId" = $2', [site.Id, user.businessId]);
    const versionNumber = current[0].MaxVersion + 1;
    const versionId = randomUUID();
    await client.query(
      `INSERT INTO "StorefrontVersions" ("Id", "BusinessId", "StorefrontId", "VersionNumber", "SchemaVersion", "TemplateKey", "DocumentJson", "Note", "PublishedByUserId", "RolledBackFromVersion", "CreatedAtUtc")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now())`,
      [versionId, user.businessId, site.Id, versionNumber, document.schemaVersion, document.templateKey, JSON.stringify(document), clean(note), user.userId, rolledBackFromVersion]);
    for (const mediaId of validation.mediaIds) {
      await client.query(`INSERT INTO "StorefrontVersionMedia" ("BusinessId", "VersionId", "MediaAssetId") VALUES ($1, $2, $3)`,
        [user.businessId, versionId, mediaId]);
    }
    if (updateDraft) {
      await client.query(
        `UPDATE "Storefronts" SET "PublishedVersionId" = $3, "Status" = 'Published', "DraftJson" = $4, "TemplateKey" = $5,
         "DraftRevision" = "DraftRevision" + 1, "UpdatedAtUtc" = now() WHERE "Id" = $1 AND "BusinessId" = $2`,
        [site.Id, user.businessId, versionId, JSON.stringify(document), document.templateKey]);
    } else {
      await client.query(`UPDATE "Storefronts" SET "PublishedVersionId" = $3, "Status" = 'Published', "UpdatedAtUtc" = now() WHERE "Id" = $1 AND "BusinessId" = $2`,
        [site.Id, user.businessId, versionId]);
    }
    await audit(client, user, rolledBackFromVersion == null ? 'storefront.published' : 'storefront.rolled_back', site.Id, { version: versionNumber, rolledBackFrom: rolledBackFromVersion });
    return {
      version: { versionNumber, templateKey: document.templateKey, note: clean(note), publishedAtUtc: new Date().toISOString(),
        publishedByUserId: user.userId, rolledBackFromVersion, isLive: true },
      contrastWarnings: getContrastWarnings(document),
    };
  });
}

export async function publishStorefront(pool, user, storefrontId, request) {
  const site = await loadDraft(pool, user, storefrontId);
  const document = parseStorefrontDocument(site.DraftJson);
  return publishDocument(pool, user, site, document, request.note);
}

export async function unpublishStorefront(pool, user, storefrontId) {
  await withTransaction(pool, async (client) => {
    const site = await loadDraft(client, user, storefrontId, true);
    if (site.Status !== 'Published') throw AppError.conflict('not_published', 'This site is not published.');
    await client.query(`UPDATE "Storefronts" SET "Status" = 'Unpublished', "UpdatedAtUtc" = now() WHERE "Id" = $1 AND "BusinessId" = $2`, [storefrontId, user.businessId]);
    await audit(client, user, 'storefront.unpublished', storefrontId);
  });
}

/** One window of a storefront's version history (newest first): { rows, totalCount }. */
export async function listStorefrontVersionsWindow(pool, user, storefrontId, window) {
  const site = await loadDraft(pool, user, storefrontId);
  const { rows, totalCount } = await windowedRows((sql, params) => pool.query(sql, params),
    `SELECT "VersionNumber", "TemplateKey", "Note", "CreatedAtUtc", "PublishedByUserId", "RolledBackFromVersion", "Id"
     FROM "StorefrontVersions" WHERE "StorefrontId" = $1 AND "BusinessId" = $2 ORDER BY "VersionNumber" DESC, "Id"`, [storefrontId, user.businessId], window);
  return { totalCount, rows: rows.map((version) => ({ versionNumber: version.VersionNumber, templateKey: version.TemplateKey, note: version.Note,
    publishedAtUtc: version.CreatedAtUtc, publishedByUserId: version.PublishedByUserId,
    rolledBackFromVersion: version.RolledBackFromVersion,
    isLive: site.Status === 'Published' && site.PublishedVersionId === version.Id })) };
}

export async function getStorefrontVersion(pool, user, storefrontId, number) {
  await loadDraft(pool, user, storefrontId);
  const { rows } = await pool.query(
    `SELECT "DocumentJson" FROM "StorefrontVersions" WHERE "StorefrontId" = $1 AND "BusinessId" = $2 AND "VersionNumber" = $3`,
    [storefrontId, user.businessId, number]);
  if (!rows[0]) throw AppError.notFound('version_not_found', 'That version does not exist.');
  return typeof rows[0].DocumentJson === 'string' ? JSON.parse(rows[0].DocumentJson) : rows[0].DocumentJson;
}

export async function rollbackStorefront(pool, user, storefrontId, number, request) {
  const site = await loadDraft(pool, user, storefrontId);
  const { rows } = await pool.query(
    `SELECT "DocumentJson" FROM "StorefrontVersions" WHERE "StorefrontId" = $1 AND "BusinessId" = $2 AND "VersionNumber" = $3`,
    [storefrontId, user.businessId, number]);
  if (!rows[0]) throw AppError.notFound('version_not_found', 'That version does not exist.');
  const document = parseStorefrontDocument(rows[0].DocumentJson);
  return publishDocument(pool, user, site, document, request.note ?? `Rolled back to version ${number}`, number,
    { updateDraft: true, checkCollectionsAndCategories: false });
}

/**
 * Sections the target template's own starter layout has that the draft lacks. Pages are matched by kind and sections by type:
 * a starter section is missing when the draft's page of that kind (after the switch) holds fewer sections of that type than the
 * starter does. Sections the target does not support are being set aside, so they do not count as present; archived sections the
 * target supports come back on the home page, so they do. A kind of page the draft no longer has is skipped.
 */
function templateSwitchAdditions(document, target, siteName) {
  const present = new Map();
  const count = (kind, type) => present.set(`${kind}|${type}`, (present.get(`${kind}|${type}`) ?? 0) + 1);
  for (const page of document.pages) for (const section of page.sections) if (target[section.type]) count(page.kind, section.type);
  for (const section of document.archive) if (target[section.type]) count('home', section.type);
  const starter = starterDocument(siteName, target.key);
  const additions = [];
  for (const starterPage of starter.pages) {
    const draftPage = document.pages.find((page) => page.kind === starterPage.kind);
    if (!draftPage) continue;
    const seen = new Map();
    for (const section of starterPage.sections) {
      const key = `${starterPage.kind}|${section.type}`;
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      if (nth > (present.get(key) ?? 0)) additions.push({ pageKind: starterPage.kind, page: draftPage.title, section });
    }
  }
  return { additions, starterPages: starter.pages };
}

/** Replaces any starter page id inside a section's content with the id of the draft's page of the same kind, or an enquiry action when there is none. */
function remapStarterPageIds(value, idMap, fallback) {
  if (typeof value === 'string') return idMap.has(value) ? (idMap.get(value) ?? fallback) : value;
  if (Array.isArray(value)) return value.map((item) => remapStarterPageIds(item, idMap, fallback));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapStarterPageIds(item, idMap, fallback)]));
  return value;
}

function templateSwitchPlan(document, target, siteName = 'Storefront') {
  const kept = [];
  const converted = [];
  const archived = [];
  const restored = [];
  for (const page of document.pages) {
    for (const section of page.sections) {
      const supported = target[section.type];
      if (!supported) archived.push({ sectionId: section.id, type: section.type, fromVariant: section.variant, toVariant: null, page: page.title });
      else if (supported.includes(section.variant)) kept.push({ sectionId: section.id, type: section.type, fromVariant: section.variant, toVariant: section.variant, page: page.title });
      else converted.push({ sectionId: section.id, type: section.type, fromVariant: section.variant, toVariant: supported[0], page: page.title });
    }
  }
  const home = document.pages.find((page) => page.kind === 'home');
  for (const section of document.archive.filter((item) => target[item.type])) {
    const variants = target[section.type];
    restored.push({ sectionId: section.id, type: section.type, fromVariant: section.variant,
      toVariant: variants.includes(section.variant) ? section.variant : variants[0], page: home?.title ?? 'Home' });
  }
  const found = templateSwitchAdditions(document, target, siteName);
  const additions = found.additions.map((item) => ({ type: item.section.type, variant: item.section.variant, page: item.page }));
  const canonical = [document.templateKey, target.key,
    ...kept.map((item) => `k${item.sectionId}`),
    ...converted.map((item) => `c${item.sectionId}>${item.toVariant}`),
    ...archived.map((item) => `a${item.sectionId}`),
    ...restored.map((item) => `r${item.sectionId}>${item.toVariant}`),
    ...found.additions.map((item) => `n${item.pageKind}:${item.section.type}:${item.section.variant}`)].join('|');
  const token = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return { fromTemplate: document.templateKey, toTemplate: target.key,
    needsConfirmation: converted.length > 0 || archived.length > 0, kept, converted, archived, restored, additions, token };
}

export async function previewStorefrontTemplateSwitch(pool, user, storefrontId, targetKey) {
  const site = await loadDraft(pool, user, storefrontId);
  const target = storefrontDocumentCatalog.templates[targetKey];
  if (!target) throw AppError.badRequest('unknown_template', 'That template does not exist.');
  await requireTier(pool, user.businessId, 'storefront.template_tier', target.tier);
  const builder = await entitlementValue(pool, user.businessId, 'storefront.builder', 'false') === 'true';
  return { ...templateSwitchPlan(parseStorefrontDocument(site.DraftJson), { ...target, key: targetKey }, site.Name), canAddSections: builder };
}

export async function applyStorefrontTemplateSwitch(pool, user, storefrontId, request) {
  const current = await loadDraft(pool, user, storefrontId);
  if (current.DraftRevision !== request.expectedRevision) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
  const target = storefrontDocumentCatalog.templates[request.targetTemplate];
  if (!target) throw AppError.badRequest('unknown_template', 'That template does not exist.');
  await requireTier(pool, user.businessId, 'storefront.template_tier', target.tier);
  const previous = parseStorefrontDocument(current.DraftJson);
  const plan = templateSwitchPlan(previous, { ...target, key: request.targetTemplate }, current.Name);
  if (request.addTemplateSections && plan.additions.length > 0) {
    // Adding sections changes the structure of the site, which only the visual builder plans may do.
    const builder = await entitlementValue(pool, user.businessId, 'storefront.builder', 'false') === 'true';
    if (!builder) throw AppError.forbidden('feature_not_in_plan', 'Adding a template\u2019s sections needs a plan with the visual builder. You can still switch the template and keep your own sections.', { entitlement: 'storefront.builder' });
  }
  if (plan.token !== request.token) throw AppError.conflict('plan_changed', 'The site changed since you previewed this switch. Preview it again before applying.');

  const document = structuredClone(previous);
  document.templateKey = request.targetTemplate;
  for (const page of document.pages) {
    const kept = [];
    for (const section of page.sections) {
      const variants = target[section.type];
      if (!variants) document.archive.push(section);
      else {
        if (!variants.includes(section.variant)) section.variant = variants[0];
        kept.push(section);
      }
    }
    page.sections = kept;
  }
  const home = document.pages.find((page) => page.kind === 'home');
  const restored = document.archive.filter((section) => target[section.type]);
  for (const section of restored) {
    const variants = target[section.type];
    if (!variants.includes(section.variant)) section.variant = variants[0];
    document.archive.splice(document.archive.indexOf(section), 1);
    home.sections.push(section);
  }
  let added = 0;
  if (request.addTemplateSections) {
    const found = templateSwitchAdditions(previous, { ...target, key: request.targetTemplate }, current.Name);
    const kindOfStarterId = new Map(found.starterPages.map((starterPage) => [starterPage.id, starterPage.kind]));
    const idMap = new Map([...kindOfStarterId].map(([starterId, kind]) => [starterId, document.pages.find((page) => page.kind === kind)?.id ?? null]));
    for (const item of found.additions) {
      const page = document.pages.find((entry) => entry.kind === item.pageKind);
      if (!page) continue;
      // Added sections go after the owner's own, so the order the owner chose is left alone.
      page.sections.push({ ...item.section, props: remapStarterPageIds(item.section.props, idMap, 'action:inquiry') });
      added += 1;
    }
  }
  if (request.useTemplateTheme) {
    document.theme = { preset: target.preset, colors: {}, headingFont: null, bodyFont: null, headingStyle: null, buttonShape: null, radius: null, sectionSpacing: null };
    // A section's own colours, background image and button shape would hide the template's look (for example a navy hero kept from an older template); alignment and spacing are layout and stay.
    for (const page of document.pages) {
      for (const section of page.sections) {
        section.style = { ...(section.style ?? {}), background: null, backgroundMediaId: null, textColor: null, buttonShape: null };
      }
    }
  }
  const validation = await validateStorefrontDocument(pool, user.businessId, document, { previous, checkCollectionsAndCategories: false });
  const nextRevision = current.DraftRevision + 1;
  const saved = await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE "Storefronts" SET "DraftJson" = $3, "TemplateKey" = $4, "DraftRevision" = "DraftRevision" + 1, "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "BusinessId" = $2 AND "DraftRevision" = $5`,
      [storefrontId, user.businessId, JSON.stringify(document), document.templateKey, request.expectedRevision]);
    if (rowCount !== 1) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
    await audit(client, user, 'storefront.template_switched', storefrontId, { from: previous.templateKey, to: document.templateKey,
      archived: plan.archived.length, converted: plan.converted.length, added });
    return loadDraft(client, user, storefrontId);
  });
  return { storefrontId, revision: saved.DraftRevision, document, added, theme: resolveTheme(document.theme),
    contrastWarnings: getContrastWarnings(document), planIssues: validation.planIssues };
}

export { templateTiers };
/**
 * Clears the working draft. A site that has been published goes back to exactly what is live; a site that has never been
 * published starts over from its template's starter layout. Contact details and settings live outside the draft and are kept.
 */
export async function resetStorefrontDraft(pool, user, storefrontId, request) {
  const current = await loadDraft(pool, user, storefrontId);
  if (current.DraftRevision !== request.expectedRevision) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
  let document;
  let source = 'starter';
  if (current.PublishedVersionId) {
    const { rows } = await pool.query(
      `SELECT "DocumentJson" FROM "StorefrontVersions" WHERE "Id" = $1 AND "StorefrontId" = $2 AND "BusinessId" = $3`,
      [current.PublishedVersionId, storefrontId, user.businessId]);
    if (rows[0]) { document = parseStorefrontDocument(rows[0].DocumentJson); source = 'published'; }
  }
  if (!document) document = parseStorefrontDocument(defaultDocument(current.Name, current.TemplateKey));
  const previous = parseStorefrontDocument(current.DraftJson);
  const validation = await validateStorefrontDocument(pool, user.businessId, document, { previous, checkCollectionsAndCategories: false });
  const nextRevision = current.DraftRevision + 1;
  const saved = await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE "Storefronts" SET "DraftJson" = $3, "TemplateKey" = $4, "DraftRevision" = "DraftRevision" + 1, "UpdatedAtUtc" = now()
       WHERE "Id" = $1 AND "BusinessId" = $2 AND "DraftRevision" = $5`,
      [storefrontId, user.businessId, JSON.stringify(document), document.templateKey, request.expectedRevision]);
    if (rowCount !== 1) throw AppError.conflict('stale_revision', 'Someone saved a newer version of this site. Reload it before saving.');
    await audit(client, user, 'storefront.draft_reset', storefrontId, { revision: nextRevision, source });
    return loadDraft(client, user, storefrontId);
  });
  return { storefrontId, revision: saved.DraftRevision, source, document, theme: resolveTheme(document.theme),
    contrastWarnings: getContrastWarnings(document), planIssues: validation.planIssues };
}
