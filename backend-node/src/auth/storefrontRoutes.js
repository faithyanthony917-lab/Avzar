import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import * as customerPortal from './customerPortalService.js';
import * as inquiries from './inquiryService.js';
import * as storefronts from './storefrontService.js';
import * as storefrontCatalog from './storefrontCatalogService.js';
import { hasAtMostPlaces } from '../money.js';
import { sendCsv } from './csvExport.js';
import { respondList } from './listWindow.js';
import { exportInquiries } from './exportService.js';

const storefrontSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(40).nullable().optional(),
  templateKey: z.string().trim().min(1).max(40).default('standard'),
});
const storefrontSettingsSchema = z.object({
  version: z.number().int().min(0).max(4_294_967_295),
  name: z.string().trim().min(2).max(80),
  contactEmail: z.string().max(120).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  openingHours: z.string().max(300).nullable().optional(),
  workflowInquiry: z.boolean().default(true),
  workflowBooking: z.boolean().default(false),
  workflowCustomOrder: z.boolean().default(false),
  workflowContact: z.boolean().default(true),
  allowSearchIndexing: z.boolean().default(true),
});
const storefrontSlugSchema = z.object({
  version: z.number().int().min(0).max(4_294_967_295),
  slug: z.string().trim().min(3).max(40),
});
const storefrontDomainSchema = z.object({ hostname: z.string().trim().min(4).max(253) });
const saveDraftSchema = z.object({ document: z.unknown(), expectedRevision: z.number().int().min(0) });
const saveAppearanceSchema = z.object({ theme: z.record(z.string(), z.unknown()), branding: z.record(z.string(), z.unknown()), expectedRevision: z.number().int().min(0) });
const publishSchema = z.object({ note: z.string().max(200).nullable().optional() });
const convertInquirySchema = z.object({
  locationId: z.string().uuid(),
  promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value),
  garmentName: z.string().max(120).nullable().optional(),
  unitPrice: z.number().min(0).max(1_000_000_000).refine((value) => hasAtMostPlaces(value, 2)),
});
const scheduleInquirySchema = z.object({
  type: z.enum(['Fitting', 'Consultation', 'Collection', 'Delivery']).default('Fitting'),
  locationId: z.string().uuid(),
  assignedMembershipId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();
const resetDraftSchema = z.object({ expectedRevision: z.number().int().min(0) });
const templateSwitchSchema = z.object({ targetTemplate: z.string().min(1).max(40), token: z.string().min(1).max(128), useTemplateTheme: z.boolean().default(false), addTemplateSections: z.boolean().default(false), expectedRevision: z.number().int().min(0) });
const createPresetSchema = z.object({
  name: z.string().trim().min(2).max(60),
  sectionType: z.string().min(1).max(30),
  variant: z.string().min(1).max(30),
  props: z.record(z.string(), z.unknown()),
  style: z.record(z.string(), z.unknown()).nullable().optional(),
});

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export function createStorefrontRouter({ env, pool }) {
  const router = Router();
  const authLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });

  const requireStorefrontView = [requireBearerAuth(env, pool), requirePermission('storefront.view')];
  const requireStorefrontEdit = [requireBearerAuth(env, pool), requirePermission('storefront.edit')];
  const requireStorefrontPublish = [requireBearerAuth(env, pool), requirePermission('storefront.publish')];
  const requireInquiriesView = [requireBearerAuth(env, pool), requirePermission('inquiries.view')];
  const requireInquiriesManage = [requireBearerAuth(env, pool), requirePermission('inquiries.manage')];
  const requireInquiriesSchedule = [requireBearerAuth(env, pool), requirePermission('inquiries.manage'), requirePermission('fittings.manage')];
  const requireCustomersManage = [requireBearerAuth(env, pool), requirePermission('customers.manage')];

  router.get('/storefront-builder/catalog', ...requireStorefrontView, async (req, res) =>
    res.status(200).json(await storefrontCatalog.getStorefrontBuilderCatalog(pool, req.currentUser)));
  router.get('/storefront-presets', ...requireStorefrontView, async (req, res) =>
    res.status(200).json((await storefrontCatalog.getStorefrontBuilderCatalog(pool, req.currentUser)).presets));
  router.post('/storefront-presets', ...requireStorefrontEdit, async (req, res) => {
    const payload = parse(createPresetSchema, req.body);
    return res.status(201).json(await storefrontCatalog.createSectionPreset(pool, req.currentUser, payload));
  });
  router.delete('/storefront-presets/:id', ...requireStorefrontEdit, async (req, res) => {
    await storefrontCatalog.deleteSectionPreset(pool, req.currentUser, req.params.id);
    return res.status(204).end();
  });

  router.post('/customer-portal/customers/:customerId/link', authLimit, ...requireCustomersManage, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.customerId)) {
      throw AppError.notFound('customer_not_found', 'Customer was not found.');
    }
    return res.status(200).json(await customerPortal.sendCustomerPortalLink(pool, env, req.currentUser, req.params.customerId));
  });

  router.delete('/customer-portal/customers/:customerId/links', authLimit, ...requireCustomersManage, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.customerId)) {
      throw AppError.notFound('customer_not_found', 'Customer was not found.');
    }
    await customerPortal.revokeCustomerPortalLinks(pool, req.currentUser, req.params.customerId);
    return res.status(204).end();
  });

  router.post('/customer-portal/access', publicLimit, async (req, res) => {
    const payload = parse(z.object({ token: z.string().min(1).max(200) }), req.body);
    return res.status(200).json(await customerPortal.accessCustomerPortal(pool, payload.token));
  });

  router.get('/storefronts', ...requireStorefrontView, async (req, res) =>
    res.status(200).json(await storefronts.listStorefronts(pool, req.currentUser)));

  router.get('/storefronts/:id', ...requireStorefrontView, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) throw AppError.notFound('storefront_not_found', 'Site not found.');
    return res.status(200).json(await storefronts.getStorefront(pool, req.currentUser, req.params.id, env.STOREFRONT_BASE_DOMAIN));
  });

  router.post('/storefronts', ...requireStorefrontEdit, async (req, res) => {
    const payload = parse(storefrontSchema, req.body);
    const created = await storefronts.createStorefront(pool, req.currentUser, payload, env.STOREFRONT_BASE_DOMAIN);
    return res.status(201).location(`/api/storefronts/${created.id}`).json(created);
  });

  router.put('/storefronts/:id/settings', ...requireStorefrontEdit, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) throw AppError.notFound('storefront_not_found', 'Site not found.');
    const payload = parse(storefrontSettingsSchema, req.body);
    return res.status(200).json(await storefronts.updateStorefrontSettings(pool, req.currentUser, req.params.id, payload, env.STOREFRONT_BASE_DOMAIN));
  });

  router.put('/storefronts/:id/slug', ...requireStorefrontPublish, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) throw AppError.notFound('storefront_not_found', 'Site not found.');
    const payload = parse(storefrontSlugSchema, req.body);
    return res.status(200).json(await storefronts.updateStorefrontSlug(pool, req.currentUser, req.params.id, payload, env.STOREFRONT_BASE_DOMAIN));
  });

  router.post('/storefronts/:id/preview-link', ...requireStorefrontView, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) throw AppError.notFound('storefront_not_found', 'Site not found.');
    const sample = req.body?.templateKey;
    if (sample !== undefined && sample !== null && typeof sample !== 'string') throw AppError.badRequest('template_not_previewable', 'A sample is not available for that template.');
    return res.status(200).json(await storefronts.createPreviewLink(pool, env, req.currentUser, req.params.id, sample ?? null));
  });

  router.get('/storefronts/:id/draft', ...requireStorefrontView, async (req, res) =>
    res.status(200).json(await storefronts.getStorefrontDraft(pool, req.currentUser, req.params.id)));
  router.put('/storefronts/:id/draft', ...requireStorefrontEdit, async (req, res) => {
    const payload = parse(saveDraftSchema, req.body);
    return res.status(200).json(await storefronts.saveStorefrontDraft(pool, req.currentUser, req.params.id, payload));
  });
  router.post('/storefronts/:id/draft/reset', ...requireStorefrontEdit, async (req, res) => {
    const payload = parse(resetDraftSchema, req.body);
    return res.status(200).json(await storefronts.resetStorefrontDraft(pool, req.currentUser, req.params.id, payload));
  });
  router.put('/storefronts/:id/appearance', ...requireStorefrontEdit, async (req, res) => {
    const payload = parse(saveAppearanceSchema, req.body);
    return res.status(200).json(await storefronts.saveStorefrontAppearance(pool, req.currentUser, req.params.id, payload));
  });
  router.get('/storefronts/:id/template-switch', ...requireStorefrontEdit, async (req, res) =>
    res.status(200).json(await storefronts.previewStorefrontTemplateSwitch(pool, req.currentUser, req.params.id, String(req.query.target ?? ''))));
  router.post('/storefronts/:id/template-switch', ...requireStorefrontEdit, async (req, res) => {
    const payload = parse(templateSwitchSchema, req.body);
    return res.status(200).json(await storefronts.applyStorefrontTemplateSwitch(pool, req.currentUser, req.params.id, payload));
  });
  router.post('/storefronts/:id/publish', ...requireStorefrontPublish, async (req, res) => {
    const payload = parse(publishSchema, req.body ?? {});
    return res.status(200).json(await storefronts.publishStorefront(pool, req.currentUser, req.params.id, payload));
  });
  router.post('/storefronts/:id/unpublish', ...requireStorefrontPublish, async (req, res) => {
    await storefronts.unpublishStorefront(pool, req.currentUser, req.params.id);
    return res.status(204).end();
  });
  // The newest 100 versions by default (the history grows with every publish); page for the rest.
  router.get('/storefronts/:id/versions', ...requireStorefrontView, async (req, res) =>
    respondList(res, req.query, (window) => storefronts.listStorefrontVersionsWindow(pool, req.currentUser, req.params.id, window), { cap: 100 }));
  router.get('/storefronts/:id/versions/:number', ...requireStorefrontView, async (req, res) => {
    const number = Number.parseInt(req.params.number, 10);
    if (!Number.isSafeInteger(number) || number < 1) throw AppError.badRequest('invalid_version', 'The version number is invalid.');
    return res.status(200).json(await storefronts.getStorefrontVersion(pool, req.currentUser, req.params.id, number));
  });
  router.post('/storefronts/:id/versions/:number/rollback', ...requireStorefrontPublish, async (req, res) => {
    const number = Number.parseInt(req.params.number, 10);
    if (!Number.isSafeInteger(number) || number < 1) throw AppError.badRequest('invalid_version', 'The version number is invalid.');
    const payload = parse(publishSchema, req.body ?? {});
    return res.status(200).json(await storefronts.rollbackStorefront(pool, req.currentUser, req.params.id, number, payload));
  });

  router.get('/storefronts/:id/domains', ...requireStorefrontView, async (req, res) =>
    res.status(200).json(await storefronts.listStorefrontDomains(pool, req.currentUser, req.params.id)));
  router.post('/storefronts/:id/domains', ...requireStorefrontPublish, async (req, res) => {
    const payload = parse(storefrontDomainSchema, req.body);
    return res.status(201).json(await storefronts.addStorefrontDomain(pool, req.currentUser, req.params.id, payload, env.STOREFRONT_BASE_DOMAIN));
  });
  router.post('/storefronts/:id/domains/:domainId/verify', ...requireStorefrontPublish, async (req, res) =>
    res.status(200).json(await storefronts.verifyStorefrontDomain(pool, req.currentUser, req.params.id, req.params.domainId, env.STOREFRONT_DNS_LOOKUP)));
  router.delete('/storefronts/:id/domains/:domainId', ...requireStorefrontPublish, async (req, res) => {
    await storefronts.removeStorefrontDomain(pool, req.currentUser, req.params.id, req.params.domainId);
    return res.status(204).end();
  });

  router.get('/inquiries', ...requireInquiriesView, async (req, res) =>
    res.status(200).json(await inquiries.listInquiries(pool, req.currentUser, req.query)));
  router.get('/inquiries/export', ...requireInquiriesView, async (req, res) => {
    const query = req.query;
    const { csv } = await exportInquiries(pool, req.currentUser,
      (page, pageSize) => inquiries.listInquiries(pool, req.currentUser, { ...query, page, pageSize }, { maxPageSize: pageSize }),
      { status: query.status, kind: query.kind, search: query.search });
    return sendCsv(res, 'requests', csv);
  });
  router.get('/inquiries/summary', ...requireInquiriesView, async (req, res) =>
    res.status(200).json(await inquiries.summarizeInquiries(pool, req.currentUser)));
  router.get('/inquiries/:id', ...requireInquiriesView, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      throw AppError.notFound('inquiry_not_found', 'Request not found.');
    }
    return res.status(200).json(await inquiries.getInquiry(pool, req.currentUser, req.params.id));
  });
  router.put('/inquiries/:id', ...requireInquiriesManage, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      throw AppError.notFound('inquiry_not_found', 'Request not found.');
    }
    const payload = parse(z.object({ status: z.string().min(1).max(20), internalNote: z.string().max(1000).nullable().optional() }), req.body);
    return res.status(200).json(await inquiries.updateInquiry(pool, req.currentUser, req.params.id, payload));
  });
  router.post('/inquiries/:id/convert', ...requireInquiriesManage, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      throw AppError.notFound('inquiry_not_found', 'Request not found.');
    }
    const payload = parse(convertInquirySchema, req.body);
    return res.status(200).json(await inquiries.convertInquiry(pool, req.currentUser, req.params.id, payload));
  });

  router.post('/inquiries/:id/schedule', ...requireInquiriesSchedule, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      throw AppError.notFound('inquiry_not_found', 'Request not found.');
    }
    const payload = parse(scheduleInquirySchema, req.body);
    return res.status(200).json(await inquiries.scheduleInquiry(pool, req.currentUser, req.params.id, payload));
  });

  return router;
}
