import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ciEnum } from '../http/ciEnum.js';
import { isBlank, parseEnum } from '../http/enums.js';
import { AppError } from '../http/errors.js';
import { entitlementValue } from './entitlementService.js';
import { submitInquiry } from './inquiryService.js';
import { getPreviewSite } from './storefrontService.js';
import { bindTenantByLookup, bindTenantBySiteSlug } from '../db/tenantLookup.js';

const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const submitInquirySchema = z.object({
  kind: ciEnum(['Inquiry', 'Quotation', 'OrderRequest', 'Appointment', 'Contact']).default('Inquiry'),
  name: z.string().trim().min(2).max(100),
  email: z.preprocess((value) => typeof value === 'string' && !value.trim() ? null : value,
    z.string().trim().email().max(120).nullable().optional()),
  phone: z.string().trim().max(40).nullable().optional(),
  message: z.string().trim().min(3).max(2000),
  designId: z.string().uuid().nullable().optional(),
  garmentType: z.string().max(60).nullable().optional(),
  budget: z.string().max(60).nullable().optional(),
  preferredDate: optionalDate,
  eventDate: optionalDate,
  website: z.string().max(1000).optional(),
  captchaToken: z.string().max(2048).optional(),
});

const themePresets = {
  'modern-luxury': { headingFont: 'Playfair Display', bodyFont: 'Inter', headingStyle: 'normal', buttonShape: 'square', radius: 0, colors: { primary: '#C9A961', secondary: '#1A1A1D', accent: '#8C6D2F', background: '#0E0E10', text: '#E8E6E1', heading: '#F5F0E6', button: '#C9A961', buttonText: '#0E0E10', nav: '#0E0E10', navText: '#F5F0E6', footer: '#151517', footerText: '#CFCBC2', card: '#17171A', border: '#2C2C30' } },
  minimalist: { headingFont: 'Inter', bodyFont: 'Inter', headingStyle: 'normal', buttonShape: 'square', radius: 2, colors: { primary: '#111111', secondary: '#F4F4F4', accent: '#6B6B6B', background: '#FFFFFF', text: '#222222', heading: '#111111', button: '#111111', buttonText: '#FFFFFF', nav: '#FFFFFF', navText: '#111111', footer: '#F4F4F4', footerText: '#333333', card: '#FAFAFA', border: '#E2E2E2' } },
  elegant: { headingFont: 'Cormorant Garamond', bodyFont: 'Lato', headingStyle: 'normal', buttonShape: 'rounded', radius: 6, colors: { primary: '#7A2E3A', secondary: '#EFE6DA', accent: '#B08D57', background: '#FBF8F3', text: '#3A3330', heading: '#2B2220', button: '#7A2E3A', buttonText: '#FFFFFF', nav: '#FBF8F3', navText: '#2B2220', footer: '#2B2220', footerText: '#EFE6DA', card: '#FFFFFF', border: '#E4D8C8' } },
  'bold-contemporary': { headingFont: 'Oswald', bodyFont: 'Work Sans', headingStyle: 'uppercase', buttonShape: 'square', radius: 0, colors: { primary: '#FF3B30', secondary: '#F2F2F2', accent: '#FFD60A', background: '#FFFFFF', text: '#1B1B1B', heading: '#000000', button: '#000000', buttonText: '#FFFFFF', nav: '#000000', navText: '#FFFFFF', footer: '#000000', footerText: '#E6E6E6', card: '#F7F7F7', border: '#1B1B1B' } },
  'african-heritage': { headingFont: 'DM Serif Display', bodyFont: 'Nunito', headingStyle: 'normal', buttonShape: 'rounded', radius: 10, colors: { primary: '#B3411B', secondary: '#F3E2C1', accent: '#1F7A5C', background: '#FFF8EC', text: '#3B2A1A', heading: '#5A1E0C', button: '#B3411B', buttonText: '#FFFFFF', nav: '#5A1E0C', navText: '#FFF8EC', footer: '#3B2A1A', footerText: '#F3E2C1', card: '#FFFFFF', border: '#E5CFA6' } },
  'clean-professional': { headingFont: 'Montserrat', bodyFont: 'Open Sans', headingStyle: 'normal', buttonShape: 'rounded', radius: 8, colors: { primary: '#2B6CB0', secondary: '#EDF2F7', accent: '#38A169', background: '#FFFFFF', text: '#2D3748', heading: '#1A202C', button: '#2B6CB0', buttonText: '#FFFFFF', nav: '#FFFFFF', navText: '#1A202C', footer: '#1A202C', footerText: '#E2E8F0', card: '#F7FAFC', border: '#E2E8F0' } },
};

export function resolveTheme(theme = {}) {
  const preset = themePresets[theme.preset] ?? themePresets['clean-professional'];
  return {
    colors: { ...preset.colors, ...(theme.colors ?? {}) },
    headingFont: theme.headingFont ?? preset.headingFont,
    bodyFont: theme.bodyFont ?? preset.bodyFont,
    headingStyle: theme.headingStyle ?? preset.headingStyle,
    buttonShape: theme.buttonShape ?? preset.buttonShape,
    radius: theme.radius ?? preset.radius,
    sectionSpacing: theme.sectionSpacing ?? 'comfortable',
  };
}

function publicDocument(value) {
  const document = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
  document.archive = [];
  document.pages = (document.pages ?? []).filter((page) => page.visible).map((page) => ({
    ...page, sections: (page.sections ?? []).filter((section) => section.visible),
  }));
  const visiblePages = new Set(document.pages.map((page) => page.id));
  document.navigation = (document.navigation ?? []).filter((item) => item.visible && visiblePages.has(item.pageId));
  return document;
}

async function liveSite(pool, slug) {
  // The public URL carries only the slug. Bind the storefront's business before reading it and its published version.
  await bindTenantByLookup(pool, 'storefront_slug', slug);
  const { rows } = await pool.query(
    `SELECT s."Id", s."BusinessId", s."Slug", s."AllowSearchIndexing", s."PublishedVersionId", v."VersionNumber", v."DocumentJson", v."CreatedAtUtc"
     FROM "Storefronts" s JOIN "StorefrontVersions" v
       ON v."Id" = s."PublishedVersionId" AND v."StorefrontId" = s."Id" AND v."BusinessId" = s."BusinessId"
     WHERE s."Slug" = $1 AND s."Status" = 'Published'`, [slug]);
  if (!rows[0]) throw AppError.notFound('site_not_found', 'This site does not exist.');
  return rows[0];
}

async function summarizeDesigns(pool, businessId, designs) {
  const ids = designs.map((design) => design.Id);
  if (!ids.length) return [];
  const { rows: images } = await pool.query(
    `SELECT DISTINCT ON (i."DesignId") i."DesignId", i."MediaAssetId", i."AltText"
     FROM "DesignImages" i WHERE i."BusinessId" = $1 AND i."DesignId" = ANY($2::uuid[])
     ORDER BY i."DesignId", i."SortOrder"`, [businessId, ids]);
  const { rows: categories } = await pool.query(
    `SELECT "Id", "Name" FROM "DesignCategories" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`,
    [businessId, designs.map((design) => design.CategoryId).filter(Boolean)]);
  const imageByDesign = new Map(images.map((image) => [image.DesignId, image]));
  const categoryById = new Map(categories.map((category) => [category.Id, category.Name]));
  return designs.map((design) => {
    const image = imageByDesign.get(design.Id);
    return {
      id: design.Id, name: design.Name, slug: design.Slug, kind: design.Kind,
      categoryName: design.CategoryId ? categoryById.get(design.CategoryId) ?? null : null,
      basePrice: design.BasePrice === null ? null : Number(design.BasePrice), currencyCode: design.CurrencyCode,
      isFeatured: design.IsFeatured, coverMediaId: image?.MediaAssetId ?? null, coverAlt: image?.AltText ?? design.Name,
    };
  });
}

async function verifiedDomainSlug(pool, host) {
  const hostname = String(host ?? '').trim().replace(/\.$/, '').toLowerCase();
  // The domain row names the business; bind it before joining the storefront and reading the entitlement.
  await bindTenantByLookup(pool, 'storefront_hostname', hostname);
  const { rows } = await pool.query(
    `SELECT s."Slug", s."BusinessId" FROM "StorefrontDomains" d
     JOIN "Storefronts" s ON s."Id" = d."StorefrontId" AND s."BusinessId" = d."BusinessId"
     WHERE d."Hostname" = $1 AND d."Status" = 'Verified'`, [hostname]);
  const domain = rows[0];
  if (!domain || await entitlementValue(pool, domain.BusinessId, 'storefront.custom_domain', 'false') !== 'true') return null;
  return domain.Slug;
}

async function validatedSiteBaseUrl(pool, env, slug, value) {
  let url;
  try { url = new URL(value); } catch { throw AppError.badRequest('invalid_base_url', 'baseUrl must be the site\'s own https address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw AppError.badRequest('invalid_base_url', 'baseUrl must be the site\'s own https address.');
  }
  const hostname = url.hostname.toLowerCase();
  const ownSubdomain = hostname === `${slug}.${env.STOREFRONT_BASE_DOMAIN.toLowerCase()}`;
  if (!ownSubdomain && await verifiedDomainSlug(pool, hostname) !== slug) {
    throw AppError.badRequest('invalid_base_url', 'baseUrl must be the site\'s own https address.');
  }
  return `https://${hostname}`;
}

const xmlEscape = (value) => String(value).replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));

async function listPublicDesigns(pool, slug, query) {
  const site = await liveSite(pool, slug);
  const page = Number.parseInt(query.page ?? '1', 10);
  const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  const conditions = ['"BusinessId" = $1', '"Status" = \'Active\'', '"Visibility" = \'Public\''];
  const params = [site.BusinessId];
  if (query.categoryId !== undefined) {
    if (!z.string().uuid().safeParse(String(query.categoryId)).success) throw AppError.badRequest('invalid_category_id', 'The categoryId is invalid.');
    params.push(String(query.categoryId)); conditions.push(`"CategoryId" = $${params.length}`);
  }
  if (query.featured !== undefined) {
    if (!['true', 'false'].includes(String(query.featured))) throw AppError.badRequest('invalid_featured', 'featured must be true or false.');
    params.push(String(query.featured) === 'true'); conditions.push(`"IsFeatured" = $${params.length}`);
  }
  if (!isBlank(query.kind)) {
    params.push(parseEnum(String(query.kind), ['ReadyMade', 'MadeToOrder', 'Service'], 'kind')); conditions.push(`"Kind" = $${params.length}`);
  }
  if (query.search !== undefined && String(query.search).trim()) {
    const escaped = String(query.search).trim().replace(/[\\%_]/g, '\\$&');
    params.push(`%${escaped}%`);
    const index = params.length;
    conditions.push(`("Name" ILIKE $${index} ESCAPE E'\\\\' OR "Description" ILIKE $${index} ESCAPE E'\\\\' OR "GarmentType" ILIKE $${index} ESCAPE E'\\\\')`);
  }
  const where = conditions.join(' AND ');
  const { rows: totals } = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "Designs" WHERE ${where}`, params);
  const { rows } = await pool.query(
    `SELECT "Id", "Name", "Slug", "Kind", "CategoryId", "BasePrice", "CurrencyCode", "IsFeatured"
     FROM "Designs" WHERE ${where} ORDER BY "IsFeatured" DESC, "Name" LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { items: await summarizeDesigns(pool, site.BusinessId, rows), page, pageSize, totalCount: totals[0]?.TotalCount ?? 0 };
}

export { listPublicDesigns };

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export function createPublicSiteRouter({ env, pool }) {
  const router = Router();
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
  const publicSubmitLimit = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });
  router.get('/public/resolve-slug/:slug', publicLimit, async (req, res) => {
    await bindTenantBySiteSlug(pool, req.params.slug);
    const { rows } = await pool.query(`
      SELECT s."Slug" FROM "Storefronts" s WHERE s."Slug" = $1 AND s."Status" = 'Published'
      UNION ALL
      SELECT s."Slug" FROM "StorefrontSlugRedirects" r
      JOIN "Storefronts" s ON s."Id" = r."StorefrontId" AND s."BusinessId" = r."BusinessId"
      WHERE r."OldSlug" = $1 AND s."Status" = 'Published'
      LIMIT 1`, [req.params.slug]);
    if (!rows.length) throw AppError.notFound('site_not_found', 'This site does not exist.');
    return res.status(200).set('cache-control', 'public, max-age=60').json({ slug: rows[0].Slug });
  });
  router.use('/public/sites/:slug', publicLimit, async (req, res, next) => {
    await bindTenantByLookup(pool, 'storefront_redirect_slug', req.params.slug);
    const { rows } = await pool.query(`
      SELECT s."Slug" FROM "StorefrontSlugRedirects" r
      JOIN "Storefronts" s ON s."Id" = r."StorefrontId" AND s."BusinessId" = r."BusinessId"
      WHERE r."OldSlug" = $1 AND s."Status" = 'Published'`, [req.params.slug]);
    if (!rows.length) return next();
    const target = new URL(req.originalUrl, 'http://avzar.invalid');
    const oldPrefix = `/public/sites/${encodeURIComponent(req.params.slug)}`;
    target.pathname = target.pathname.replace(oldPrefix, `/public/sites/${encodeURIComponent(rows[0].Slug)}`);
    return res.set('cache-control', 'public, max-age=300').redirect(308, `${target.pathname}${target.search}`);
  });
  router.get('/public/sites/:slug', async (req, res) => {
    await bindTenantByLookup(pool, 'storefront_slug', req.params.slug);
    const { rows } = await pool.query(
      `SELECT s."Name", s."Slug", s."BusinessId", s."ContactEmail", s."ContactPhone", s."Address", s."OpeningHours",
              s."WorkflowInquiry", s."WorkflowBooking", s."WorkflowCustomOrder", s."WorkflowContact", s."AllowSearchIndexing",
              v."VersionNumber", v."DocumentJson", b."Name" AS "BusinessName", b."CurrencyCode", a."Enabled" AS "StorefrontAnalyticsEnabled"
       FROM "Storefronts" s
       JOIN "StorefrontVersions" v ON v."Id" = s."PublishedVersionId" AND v."StorefrontId" = s."Id" AND v."BusinessId" = s."BusinessId"
       JOIN "Businesses" b ON b."Id" = s."BusinessId"
       LEFT JOIN "StorefrontAnalyticsSettings" a ON a."BusinessId" = s."BusinessId"
       WHERE s."Slug" = $1 AND s."Status" = 'Published'`, [req.params.slug]);
    const site = rows[0];
    if (!site) throw AppError.notFound('site_not_found', 'This site does not exist.');
    const document = publicDocument(site.DocumentJson);
    return res.status(200).set('cache-control', 'public, max-age=60').json({
      name: site.Name, slug: site.Slug, businessName: site.BusinessName, currencyCode: site.CurrencyCode,
      templateKey: document.templateKey, versionNumber: site.VersionNumber, isPreview: false, document,
      theme: resolveTheme(document.theme),
      contact: { email: site.ContactEmail, phone: site.ContactPhone, address: site.Address, openingHours: site.OpeningHours },
      workflows: [site.WorkflowInquiry && 'inquiry', site.WorkflowBooking && 'booking', site.WorkflowCustomOrder && 'customOrder', site.WorkflowContact && 'contact'].filter(Boolean),
      allowSearchIndexing: site.AllowSearchIndexing,
      analyticsEnabled: site.StorefrontAnalyticsEnabled === true,
    });
  });
  router.get('/public/preview/:token', publicLimit, async (req, res) => {
    return res.status(200).set('cache-control', 'no-store').json(await getPreviewSite(pool, env, req.params.token));
  });
  router.get('/public/sites/:slug/designs', async (req, res) =>
    res.status(200).set('cache-control', 'public, max-age=60').json(await listPublicDesigns(pool, req.params.slug, req.query)));
  router.get('/public/sites/:slug/designs/:designSlug', async (req, res) => {
    const site = await liveSite(pool, req.params.slug);
    const { rows } = await pool.query(
      `SELECT d."Id", d."Name", d."Slug", d."Description", d."Kind", d."CategoryId", d."GarmentType", d."Tags", d."Fabrics", d."Colours", d."Sizes", d."BasePrice", d."CurrencyCode", d."ProductionDays", d."IsFeatured"
       FROM "Designs" d WHERE d."BusinessId" = $1 AND d."Slug" = $2 AND d."Status" = 'Active' AND d."Visibility" = 'Public'`,
      [site.BusinessId, req.params.designSlug]);
    const design = rows[0];
    if (!design) throw AppError.notFound('design_not_found', 'This design is not available.');
    const [category, images] = await Promise.all([
      design.CategoryId ? pool.query('SELECT "Name" FROM "DesignCategories" WHERE "Id" = $1 AND "BusinessId" = $2', [design.CategoryId, site.BusinessId]) : Promise.resolve({ rows: [] }),
      pool.query('SELECT "MediaAssetId", COALESCE("AltText", $3) AS "AltText" FROM "DesignImages" WHERE "DesignId" = $1 AND "BusinessId" = $2 ORDER BY "SortOrder"', [design.Id, site.BusinessId, design.Name]),
    ]);
    return res.status(200).set('cache-control', 'public, max-age=60').json({
      id: design.Id, name: design.Name, slug: design.Slug, description: design.Description, kind: design.Kind,
      categoryId: design.CategoryId, categoryName: category.rows[0]?.Name ?? null, garmentType: design.GarmentType,
      tags: design.Tags, fabrics: design.Fabrics, colours: design.Colours, sizes: design.Sizes,
      basePrice: design.BasePrice === null ? null : Number(design.BasePrice), currencyCode: design.CurrencyCode,
      productionDays: design.ProductionDays, isFeatured: design.IsFeatured,
      images: images.rows.map((image) => ({ mediaId: image.MediaAssetId, alt: image.AltText })),
    });
  });
  router.get('/public/sites/:slug/categories', async (req, res) => {
    const site = await liveSite(pool, req.params.slug);
    const { rows } = await pool.query(
      `SELECT c."Id", c."Name" FROM "DesignCategories" c
       WHERE c."BusinessId" = $1 AND EXISTS (
         SELECT 1 FROM "Designs" d WHERE d."BusinessId" = c."BusinessId" AND d."CategoryId" = c."Id" AND d."Status" = 'Active' AND d."Visibility" = 'Public')
       ORDER BY c."SortOrder", c."Name"`, [site.BusinessId]);
    return res.status(200).set('cache-control', 'public, max-age=60').json(rows.map((row) => ({ id: row.Id, name: row.Name })));
  });
  router.get('/public/sites/:slug/collections/:collectionSlug', async (req, res) => {
    const site = await liveSite(pool, req.params.slug);
    const collectionId = z.string().uuid().safeParse(req.params.collectionSlug).success ? req.params.collectionSlug : null;
    const { rows: collections } = await pool.query(
      `SELECT "Id", "Name", "Slug", "Description" FROM "DesignCollections"
       WHERE "BusinessId" = $1 AND "Visibility" = 'Public' AND ${collectionId ? '"Id" = $2' : '"Slug" = $2'}`,
      [site.BusinessId, collectionId ?? req.params.collectionSlug]);
    const collection = collections[0];
    if (!collection) throw AppError.notFound('collection_not_found', 'This collection is not available.');
    const { rows: designs } = await pool.query(
      `SELECT d."Id", d."Name", d."Slug", d."Kind", d."CategoryId", d."BasePrice", d."CurrencyCode", d."IsFeatured"
       FROM "DesignCollectionItems" ci JOIN "Designs" d ON d."Id" = ci."DesignId" AND d."BusinessId" = ci."BusinessId"
       WHERE ci."BusinessId" = $1 AND ci."CollectionId" = $2 AND d."Status" = 'Active' AND d."Visibility" = 'Public'
       ORDER BY ci."SortOrder"`, [site.BusinessId, collection.Id]);
    const summaries = await summarizeDesigns(pool, site.BusinessId, designs);
    return res.status(200).set('cache-control', 'public, max-age=60').json({
      id: collection.Id, name: collection.Name, slug: collection.Slug, description: collection.Description, designs: summaries,
    });
  });
  router.get('/public/resolve', publicLimit, async (req, res) => {
    if (typeof req.query.host !== 'string' || !req.query.host.trim()) throw AppError.badRequest('invalid_host', 'host is required.');
    const slug = await verifiedDomainSlug(pool, req.query.host);
    return slug ? res.status(200).json({ slug }) : res.sendStatus(404);
  });
  router.get('/public/domains/allowed', publicLimit, async (req, res) => {
    if (typeof req.query.domain !== 'string' || !req.query.domain.trim()) throw AppError.badRequest('invalid_domain', 'domain is required.');
    return await verifiedDomainSlug(pool, req.query.domain) ? res.sendStatus(200) : res.sendStatus(404);
  });
  router.get('/public/sites/:slug/sitemap.xml', async (req, res) => {
    const site = await liveSite(pool, req.params.slug);
    const baseUrl = await validatedSiteBaseUrl(pool, env, site.Slug, req.query.baseUrl);
    const result = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
    if (site.AllowSearchIndexing) {
      const document = typeof site.DocumentJson === 'string' ? JSON.parse(site.DocumentJson) : site.DocumentJson;
      for (const page of (document.pages ?? []).filter((item) => item.visible && item.kind !== 'design')) {
        const path = page.slug ? `/${page.slug}` : '/';
        result.push(`<url><loc>${xmlEscape(`${baseUrl}${path}`)}</loc><lastmod>${new Date(site.CreatedAtUtc).toISOString().slice(0, 10)}</lastmod></url>`);
      }
      const { rows: designs } = await pool.query(
        `SELECT "Slug", "UpdatedAtUtc" FROM "Designs" WHERE "BusinessId" = $1 AND "Status" = 'Active' AND "Visibility" = 'Public' ORDER BY "Name" LIMIT 5000`, [site.BusinessId]);
      for (const design of designs) result.push(`<url><loc>${xmlEscape(`${baseUrl}/design/${design.Slug}`)}</loc>${design.UpdatedAtUtc ? `<lastmod>${new Date(design.UpdatedAtUtc).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`);
      const { rows: collections } = await pool.query(
        `SELECT "Slug" FROM "DesignCollections" WHERE "BusinessId" = $1 AND "Visibility" = 'Public'`, [site.BusinessId]);
      for (const collection of collections) result.push(`<url><loc>${xmlEscape(`${baseUrl}/collection/${collection.Slug}`)}</loc></url>`);
    }
    result.push('</urlset>');
    return res.status(200).type('application/xml').send(`${result.join('\n')}\n`);
  });
  router.get('/public/sites/:slug/robots.txt', async (req, res) => {
    const site = await liveSite(pool, req.params.slug);
    const baseUrl = await validatedSiteBaseUrl(pool, env, site.Slug, req.query.baseUrl);
    const body = site.AllowSearchIndexing ? `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
    return res.status(200).type('text/plain').send(body);
  });
  router.post('/public/sites/:slug/inquiries', publicSubmitLimit, async (req, res) => {
    const payload = parse(submitInquirySchema, req.body);
    const result = await submitInquiry(pool, env, req.params.slug, payload, req.ip);
    return res.status(202).json(result);
  });
  return router;
}