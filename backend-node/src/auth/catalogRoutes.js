import { randomUUID } from 'node:crypto';
import { respondList } from './listWindow.js';
import { TextDecoder } from 'node:util';
import Busboy from 'busboy';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ciEnum } from '../http/ciEnum.js';
import { pricingInputSchema } from './pricingSchemas.js';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import {
  bulkDesignOperation, createDesign, createDesignCategory, deleteDesignCategory, exportDesigns, getDesign,
  listDesignCategories, listDesigns, setDesignImages, setDesignStatus, setDesignVisibility,
  updateDesign, updateDesignCategory,
} from './designService.js';
import { createCollection, deleteCollection, exportCollections, getCollection, listCollections, setCollectionItems, updateCollection } from './collectionService.js';
import { commitDesignCsv, previewDesignCsv } from './designCsvService.js';
import { commitCollectionCsv, previewCollectionCsv } from './collectionCsvService.js';
import { calculatePricing, getPricingProfile, savePricingProfile } from './pricingService.js';
import { applyStructuredTextDraft } from './structuredDraftApplyService.js';
import { bulkAdjustStock, bulkMoveMaterials, bulkSetMaterialActive, bulkSetReorderLevel, changeStock, commitInventoryCsv, createMaterial, listInventoryAll, listInventoryWindow, inventoryHistory, listInventoryLocations, previewInventoryCsv, taskMaterialBatch } from './inventoryService.js';

const designSchema = z.object({
  name: z.string().min(2).max(120), description: z.string().max(4000).nullish(),
  kind: ciEnum(['ReadyMade', 'MadeToOrder', 'Service']).default('MadeToOrder'),
  categoryId: z.string().uuid().nullish(), garmentType: z.string().max(60).nullish(),
  tags: z.array(z.string()).max(20).nullish(), fabrics: z.array(z.string()).max(30).nullish(),
  colours: z.array(z.string()).max(30).nullish(), sizes: z.array(z.string()).max(30).nullish(),
  basePrice: z.number().min(0).max(999_999_999.99).nullish(), productionDays: z.number().int().min(1).max(365).nullish(),
  isFeatured: z.boolean().default(false), parentDesignId: z.string().uuid().nullish(), version: z.number().int().min(0).max(4_294_967_295).nullish(),
});

const categorySchema = z.object({
  name: z.string().min(2).max(80), sortOrder: z.number().int().min(0).max(10_000).default(0),
});
const collectionSchema = z.object({
  name: z.string().min(2).max(120), description: z.string().max(2000).nullish(),
  visibility: ciEnum(['Private', 'Public']).default('Private'), sortOrder: z.number().int().min(0).max(10_000).default(0),
  version: z.number().int().min(0).max(4_294_967_295).nullish(),
});

const pricingProfileSchema = z.object({
  defaultHourlyRate: z.number().min(0).max(1_000_000).default(0),
  overheadPercent: z.number().min(0).max(200).default(0),
  method: ciEnum(['Markup', 'Margin']).default('Margin'),
  targetPercent: z.number().min(0).max(1000).default(0),
  taxPercent: z.number().min(0).max(100).default(0),
  roundingStep: z.number().min(0).max(1_000_000).default(0),
  version: z.number().int().min(0).max(4_294_967_295).nullish(),
});

const inventorySchema = z.object({
  sku: z.string().min(1).max(64), name: z.string().min(1).max(160), unit: z.string().min(1).max(24),
  locationId: z.string().uuid().nullish(), openingStock: z.number().min(0).max(1_000_000_000).default(0),
  reorderLevel: z.number().min(0).max(1_000_000_000).default(0), notes: z.string().max(1000).nullish(),
});
const stockChangeSchema = z.object({
  quantity: z.number().positive().max(1_000_000_000).refine((value) => /^\d+(?:\.\d{1,3})?$/.test(String(value))),
  note: z.string().max(500).nullish(), orderId: z.string().uuid().nullish(), taskId: z.string().uuid().nullish(),
  expectedVersion: z.number().int().min(0).max(4_294_967_295).nullish(),
});
const taskMaterialsSchema = z.object({
  materials: z.array(z.object({ materialId: z.string().uuid(), quantity: z.number().positive().max(1_000_000_000).refine((value) => /^\d+(?:\.\d{1,3})?$/.test(String(value))) })).min(1).max(100),
  note: z.string().max(500).nullish(),
});

async function readCsvFile(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, parts: 5 } }); }
    catch { reject(AppError.badRequest('csv_empty', 'Choose a non-empty CSV file.')); return; }
    let fileSeen = false;
    let truncated = false;
    const chunks = [];
    const fields = {};
    parser.on('file', (fieldName, stream) => {
      if (fieldName !== 'file' || fileSeen) { stream.resume(); return; }
      fileSeen = true;
      stream.on('limit', () => { truncated = true; });
      stream.on('data', (chunk) => {
        if (chunk.includes(0)) truncated = 'binary';
        chunks.push(chunk);
      });
    });
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('error', () => reject(AppError.badRequest('csv_malformed', 'The uploaded form is malformed.')));
    parser.on('close', () => {
      if (!fileSeen || chunks.reduce((size, chunk) => size + chunk.length, 0) === 0) { reject(AppError.badRequest('csv_empty', 'Choose a non-empty CSV file.')); return; }
      if (truncated === true) { reject(AppError.badRequest('file_too_large', 'CSV must be under 5 MB.')); return; }
      if (truncated === 'binary') { reject(AppError.badRequest('csv_not_text', 'This does not look like a CSV text file.')); return; }
      try { resolve({ csv: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), fields }); }
      catch { reject(AppError.badRequest('csv_not_utf8', 'Save the file as CSV UTF-8 and try again.')); }
    });
    req.pipe(parser);
  });
}

function boolForm(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw AppError.badRequest('validation_failed', 'SkipInvalidRows must be true or false.');
}

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export function createCatalogRouter({ env, pool }) {
  const router = Router();

  const requireDesignsView = [requireBearerAuth(env, pool), requirePermission('designs.view')];
  const requireDesignsManage = [requireBearerAuth(env, pool), requirePermission('designs.manage')];
  const requirePricingView = [requireBearerAuth(env, pool), requirePermission('pricing.view')];
  const requirePricingManage = [requireBearerAuth(env, pool), requirePermission('pricing.manage')];
  const requireInventoryView = [requireBearerAuth(env, pool), requirePermission('inventory.view')];
  const requireInventoryManage = [requireBearerAuth(env, pool), requirePermission('inventory.manage')];
  const uploadLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  router.get('/designs/export', ...requireDesignsView, async (req, res) => {
    const csv = await exportDesigns(pool, req.currentUser.businessId, req.query);
    return res.status(200).type('text/csv; charset=utf-8').attachment(`designs-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.csv`).send(csv);
  });

  router.post('/designs/import/preview', ...requireDesignsManage, uploadLimit, async (req, res) => {
    const { csv } = await readCsvFile(req);
    return res.status(200).json(await previewDesignCsv(pool, req.currentUser, csv));
  });

  router.post('/designs/import/commit', ...requireDesignsManage, uploadLimit, async (req, res) => {
    const { csv, fields } = await readCsvFile(req);
    if (!fields.expectedHash) throw AppError.badRequest('validation_failed', 'ExpectedHash is required.');
    return res.status(200).json(await commitDesignCsv(pool, req.currentUser, csv, {
      expectedHash: fields.expectedHash, skipInvalidRows: boolForm(fields.skipInvalidRows),
    }));
  });

  router.post('/designs/bulk', ...requireDesignsManage, async (req, res) => {
    const payload = parse(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      action: ciEnum(['status', 'visibility', 'featured']),
      status: ciEnum(['Active', 'Archived']).optional(),
      visibility: ciEnum(['Private', 'Public']).optional(),
      isFeatured: z.boolean().optional(),
    }), req.body);
    return res.status(200).json(await bulkDesignOperation(pool, req.currentUser, payload));
  });

  router.get('/designs', ...requireDesignsView, async (req, res) =>
    res.status(200).json(await listDesigns(pool, req.currentUser.businessId, req.query)));

  router.get('/designs/:id', ...requireDesignsView, async (req, res) => {
    return res.status(200).json(await getDesign(pool, req.currentUser.businessId, req.params.id));
  });

  router.post('/designs', ...requireDesignsManage, async (req, res) => {
    const payload = parse(designSchema, req.body);
    return res.status(201).json(await createDesign(pool, req.currentUser, payload));
  });

  router.put('/designs/:id', ...requireDesignsManage, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.badRequest('invalid_design_id', 'The design ID is invalid.');
    const payload = parse(designSchema, req.body);
    return res.status(200).json(await updateDesign(pool, req.currentUser, req.params.id, payload));
  });

  router.post('/designs/:id/status', ...requireDesignsManage, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.badRequest('invalid_design_id', 'The design ID is invalid.');
    const payload = parse(z.object({ status: ciEnum(['Active', 'Archived']) }), req.body);
    return res.status(200).json(await setDesignStatus(pool, req.currentUser, req.params.id, payload));
  });

  router.put('/designs/:id/images', ...requireDesignsManage, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.badRequest('invalid_design_id', 'The design ID is invalid.');
    const payload = parse(z.object({ images: z.array(z.object({ mediaId: z.string().uuid(), altText: z.string().max(200).nullish() })).max(10).default([]) }), req.body);
    return res.status(200).json(await setDesignImages(pool, req.currentUser, req.params.id, payload));
  });

  router.post('/designs/:id/visibility', ...requireDesignsManage, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.badRequest('invalid_design_id', 'The design ID is invalid.');
    const payload = parse(z.object({ visibility: ciEnum(['Private', 'Public']) }), req.body);
    return res.status(200).json(await setDesignVisibility(pool, req.currentUser, req.params.id, payload));
  });

  router.get('/design-categories', ...requireDesignsView, async (req, res) =>
    res.status(200).json(await listDesignCategories(pool, req.currentUser.businessId)));

  router.post('/design-categories', ...requireDesignsManage, async (req, res) => {
    const payload = parse(categorySchema, req.body);
    return res.status(201).json(await createDesignCategory(pool, req.currentUser, payload));
  });

  router.put('/design-categories/:id', ...requireDesignsManage, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.badRequest('invalid_category_id', 'The category ID is invalid.');
    const payload = parse(categorySchema, req.body);
    return res.status(200).json(await updateDesignCategory(pool, req.currentUser, req.params.id, payload));
  });

  router.delete('/design-categories/:id', ...requireDesignsManage, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.badRequest('invalid_category_id', 'The category ID is invalid.');
    await deleteDesignCategory(pool, req.currentUser, req.params.id);
    return res.status(204).end();
  });

  router.post('/collections/import/preview', ...requireDesignsManage, uploadLimit, async (req, res) => {
    const { csv } = await readCsvFile(req);
    return res.status(200).json(await previewCollectionCsv(pool, req.currentUser, csv));
  });

  router.post('/collections/import/commit', ...requireDesignsManage, uploadLimit, async (req, res) => {
    const { csv, fields } = await readCsvFile(req);
    if (!fields.expectedHash) throw AppError.badRequest('validation_failed', 'ExpectedHash is required.');
    return res.status(200).json(await commitCollectionCsv(pool, req.currentUser, csv, {
      expectedHash: fields.expectedHash, skipInvalidRows: boolForm(fields.skipInvalidRows),
    }));
  });

  router.post('/ai/text-assistant/drafts/apply', ...requireDesignsManage, async (req, res) => {
    const payload = parse(z.discriminatedUnion('type', [
      z.object({ type: z.literal('product_description'), targetId: z.string().uuid(), version: z.number().int().min(0), description: z.string().trim().min(1).max(2500) }),
      z.object({ type: z.literal('collection_names'), targetId: z.string().uuid(), version: z.number().int().min(0), name: z.string().trim().min(2).max(120) }),
    ]), req.body);
    return res.status(200).json(await applyStructuredTextDraft(pool, req.currentUser, payload));
  });

  router.get('/collections/export', ...requireDesignsView, async (req, res) => {
    const csv = await exportCollections(pool, req.currentUser.businessId, req.query);
    return res.status(200).type('text/csv; charset=utf-8').attachment(`collections-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.csv`).send(csv);
  });

  router.get('/collections', ...requireDesignsView, async (req, res) =>
    res.status(200).json(await listCollections(pool, req.currentUser.businessId, req.query)));

  router.get('/collections/:id', ...requireDesignsView, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw AppError.notFound('collection_not_found', 'Collection not found.');
    return res.status(200).json(await getCollection(pool, req.currentUser.businessId, req.params.id));
  });

  router.post('/collections', ...requireDesignsManage, async (req, res) => {
    const payload = parse(collectionSchema, req.body);
    return res.status(201).json(await createCollection(pool, req.currentUser, payload));
  });

  router.put('/collections/:id', ...requireDesignsManage, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.badRequest('invalid_collection_id', 'The collection ID is invalid.');
    const payload = parse(collectionSchema, req.body);
    return res.status(200).json(await updateCollection(pool, req.currentUser, req.params.id, payload));
  });

  router.put('/collections/:id/items', ...requireDesignsManage, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw AppError.notFound('collection_not_found', 'Collection not found.');
    const payload = parse(z.object({ designIds: z.array(z.string().uuid()).max(100).default([]) }), req.body);
    return res.status(200).json(await setCollectionItems(pool, req.currentUser, req.params.id, payload.designIds));
  });

  router.delete('/collections/:id', ...requireDesignsManage, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw AppError.notFound('collection_not_found', 'Collection not found.');
    await deleteCollection(pool, req.currentUser, req.params.id);
    return res.status(204).end();
  });

  router.get('/pricing/profile', ...requirePricingView, async (req, res) =>
    res.status(200).json(await getPricingProfile(pool, req.currentUser.businessId)));

  router.put('/pricing/profile', ...requirePricingManage, async (req, res) => {
    const payload = parse(pricingProfileSchema, req.body);
    return res.status(200).json(await savePricingProfile(pool, req.currentUser, payload));
  });

  router.post('/pricing/calculate', ...requirePricingView, async (req, res) => {
    const payload = parse(pricingInputSchema, req.body);
    return res.status(200).json(await calculatePricing(pool, req.currentUser.businessId, payload));
  });

  router.get('/inventory/export', ...requireInventoryView, async (req, res) => {
    const rows = await listInventoryAll(pool, req.currentUser);
    const csvCell = (value) => {
      if (value == null || value === '') return '';
      let text = String(value).replaceAll('\0', '');
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const csv = [['SKU','Name','Unit','Opening stock','Reorder level','Location ID','Reserved','Available','Low stock'],
      ...rows.map((row) => [row.sku,row.name,row.unit,row.onHand,row.reorderLevel,row.locationId,row.reserved,row.available,row.lowStock ? 'yes' : 'no'])]
      .map((row) => row.map(csvCell).join(',')).join('\r\n');
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return res.status(200).type('text/csv; charset=utf-8').attachment(`inventory-${date}.csv`).send(`\uFEFF${csv}\r\n`);
  });

  router.post('/inventory/import/preview', ...requireInventoryManage, uploadLimit, async (req, res) => {
    const { csv } = await readCsvFile(req);
    return res.status(200).json(await previewInventoryCsv(pool, req.currentUser, csv));
  });

  router.post('/inventory/import/commit', ...requireInventoryManage, uploadLimit, async (req, res) => {
    const { csv, fields } = await readCsvFile(req);
    if (!fields.expectedHash) throw AppError.badRequest('validation_failed', 'ExpectedHash is required.');
    return res.status(200).json(await commitInventoryCsv(pool, req.currentUser, csv,
      { expectedHash: fields.expectedHash, skipInvalidRows: boolForm(fields.skipInvalidRows) }));
  });

  router.post('/inventory/bulk/reorder-level', ...requireInventoryManage, async (req, res) => {
    const payload = parse(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      reorderLevel: z.number().min(0).max(1_000_000_000).refine((value) => /^\d+(?:\.\d{1,3})?$/.test(String(value))),
    }), req.body);
    return res.status(200).json(await bulkSetReorderLevel(pool, req.currentUser, payload));
  });

  router.post('/inventory/bulk/active', ...requireInventoryManage, async (req, res) => {
    const payload = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), active: z.boolean() }), req.body);
    return res.status(200).json(await bulkSetMaterialActive(pool, req.currentUser, payload));
  });

  router.post('/inventory/bulk/move', ...requireInventoryManage, async (req, res) => {
    const payload = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), locationId: z.string().uuid() }), req.body);
    return res.status(200).json(await bulkMoveMaterials(pool, req.currentUser, payload));
  });

  router.post('/inventory/bulk/adjust', ...requireInventoryManage, async (req, res) => {
    const payload = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), quantity: z.number().min(0).max(1_000_000_000).refine((value) => /^\d+(?:\.\d{1,3})?$/.test(String(value))), reason: z.string().trim().min(1).max(500) }), req.body);
    return res.status(200).json(await bulkAdjustStock(pool, req.currentUser, payload));
  });

  router.get('/inventory', ...requireInventoryView, async (req, res) =>
    respondList(res, req.query, (window) => listInventoryWindow(pool, req.currentUser, window)));

  router.get('/inventory/locations', ...requireInventoryView, async (req, res) =>
    res.status(200).json(await listInventoryLocations(pool, req.currentUser)));

  router.post('/inventory', ...requireInventoryManage, async (req, res) => {
    const payload = parse(inventorySchema, req.body);
    return res.status(201).json(await createMaterial(pool, req.currentUser, payload));
  });

  router.post('/inventory/:id/:actionName', ...requireInventoryManage, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw AppError.badRequest('invalid_inventory_id', 'The inventory ID is invalid.');
    const payload = parse(stockChangeSchema, req.body);
    return res.status(200).json(await changeStock(pool, req.currentUser, req.params.id, req.params.actionName, payload));
  });

  router.post('/inventory/tasks/:taskId/reserve', ...requireInventoryManage, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.taskId).success) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(taskMaterialsSchema, req.body);
    return res.status(200).json(await taskMaterialBatch(pool, req.currentUser, req.params.taskId, payload, 'Reserve'));
  });

  router.post('/inventory/tasks/:taskId/release', ...requireInventoryManage, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.taskId).success) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(taskMaterialsSchema, req.body);
    return res.status(200).json(await taskMaterialBatch(pool, req.currentUser, req.params.taskId, payload, 'Release'));
  });

  router.post('/inventory/tasks/:taskId/consume', ...requireInventoryManage, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.taskId).success) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(taskMaterialsSchema, req.body);
    return res.status(200).json(await taskMaterialBatch(pool, req.currentUser, req.params.taskId, payload, 'Consume'));
  });

  router.get('/inventory/:id/movements', ...requireInventoryView, async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw AppError.badRequest('invalid_inventory_id', 'The inventory ID is invalid.');
    const take = req.query.take === undefined ? 100 : Number(req.query.take);
    if (!Number.isSafeInteger(take)) throw AppError.badRequest('invalid_take', 'Take must be an integer.');
    return res.status(200).json(await inventoryHistory(pool, req.currentUser, req.params.id, take));
  });

  return router;
}
