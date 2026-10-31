import { rateLimit } from 'express-rate-limit';
import { Router } from 'express';
import { AppError } from '../http/errors.js';
import { readMultipart } from '../http/multipart.js';
import { CUSTOMER_CSV_MAX_BYTES, commitCustomerImport, exportCustomers, previewCustomerImport } from './customerImportService.js';
import { invoicePdf, jobSheetPdf, measurementPdf, quotationPdf } from './pdfService.js';
import { searchBusiness } from './searchService.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { deleteMedia, getMedia, listMedia, mediaUsage, openMedia, uploadMedia } from './mediaService.js';
import { deleteDocument, getDocument, listDocuments, openDocument, uploadDocument } from './documentService.js';
import { createVirusScanner } from './documentService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createMediaRouter({ env, pool, storage, virusScanner = createVirusScanner(env) }) {
  const router = Router();

  const requireMediaView = [requireBearerAuth(env, pool), requirePermission('media.view')];
  const requireMediaManage = [requireBearerAuth(env, pool), requirePermission('media.manage')];
  const requireDocumentsView = [requireBearerAuth(env, pool), requirePermission('documents.view')];
  const requireDocumentsManage = [requireBearerAuth(env, pool), requirePermission('documents.manage')];
  const requireSearchAuth = [requireBearerAuth(env, pool)];
  const uploadLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  router.get('/media', ...requireMediaView, async (req, res) => res.status(200).json(await listMedia(pool, req.currentUser, req.query)));
  router.get('/media/usage', ...requireMediaView, async (req, res) => res.status(200).json(await mediaUsage(pool, env, req.currentUser)));

  router.get('/media/:id/file/:variant', ...requireMediaView, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('media_not_found', 'Image not found.');
    const file = await openMedia(pool, storage, req.currentUser, req.params.id, req.params.variant);
    res.set('cache-control', 'private, max-age=300').set('x-content-type-options', 'nosniff');
    res.status(200).type(file.contentType);
    file.content.on('error', (error) => res.destroy(error));
    return file.content.pipe(res);
  });

  router.get('/media/:id', ...requireMediaView, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('media_not_found', 'Image not found.');
    return res.status(200).json(await getMedia(pool, req.currentUser, req.params.id));
  });

  router.post('/media', uploadLimit, ...requireMediaManage, async (req, res) => {
    const { file, fields } = await readMultipart(req, { maxBytes: env.MEDIA_MAX_UPLOAD_BYTES, maxFields: 1, maxParts: 2, allowedFields: ['purpose'] });
    const asset = await uploadMedia(pool, env, storage, req.currentUser, file.bytes, file.fileName, fields.purpose ?? 'DesignImage');
    return res.status(201).location(`/api/media/${asset.id}`).json(asset);
  });

  router.delete('/media/:id', ...requireMediaManage, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('media_not_found', 'Image not found.');
    await deleteMedia(pool, storage, req.currentUser, req.params.id);
    return res.status(204).end();
  });

  router.get('/documents', ...requireDocumentsView, async (req, res) => res.status(200).json(await listDocuments(pool, req.currentUser, req.query)));
  router.get('/documents/:id/file', ...requireDocumentsView, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('document_not_found', 'Document not found.');
    const file = await openDocument(pool, storage, req.currentUser, req.params.id);
    res.set('cache-control', 'private, no-store').set('x-content-type-options', 'nosniff');
    res.status(200).type(file.contentType).attachment(file.fileName);
    file.content.on('error', (error) => res.destroy(error));
    return file.content.pipe(res);
  });
  router.get('/documents/:id', ...requireDocumentsView, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('document_not_found', 'Document not found.');
    return res.status(200).json(await getDocument(pool, req.currentUser, req.params.id));
  });
  router.post('/documents', uploadLimit, ...requireDocumentsManage, async (req, res) => {
    const { file, fields } = await readMultipart(req, { maxBytes: env.DOCUMENT_MAX_UPLOAD_BYTES, maxFields: 3, maxParts: 4,
      allowedFields: ['description', 'customerId', 'orderId'] });
    const document = await uploadDocument(pool, env, storage, virusScanner, req.currentUser, file.bytes, file.fileName, fields);
    return res.status(201).location(`/api/documents/${document.id}`).json(document);
  });
  router.delete('/documents/:id', ...requireDocumentsManage, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('document_not_found', 'Document not found.');
    await deleteDocument(pool, storage, req.currentUser, req.params.id);
    return res.status(204).end();
  });

  router.get('/customers/export', ...[requireBearerAuth(env, pool), requirePermission('customers.view')], async (req, res) => {
    const csv = await exportCustomers(pool, req.currentUser);
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return res.status(200).type('text/csv; charset=utf-8').attachment(`customers-${date}.csv`).send(csv);
  });
  router.post('/customers/import/preview', uploadLimit, ...[requireBearerAuth(env, pool), requirePermission('customers.manage')], async (req, res) => {
    const { file } = await readMultipart(req, { maxBytes: CUSTOMER_CSV_MAX_BYTES + 512 * 1024, maxFields: 0, maxParts: 1, allowedFields: [] });
    if (file.bytes.length > CUSTOMER_CSV_MAX_BYTES) throw AppError.badRequest('file_too_large', 'CSV must be under 5 MB.');
    if (file.bytes.includes(0)) throw AppError.badRequest('csv_not_text', 'This does not look like a CSV text file.');
    let csv;
    try { csv = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
    catch { throw AppError.badRequest('csv_not_utf8', 'Save the file as "CSV UTF-8" and try again.'); }
    return res.status(200).json(await previewCustomerImport(pool, req.currentUser, csv));
  });
  router.post('/customers/import/commit', uploadLimit, ...[requireBearerAuth(env, pool), requirePermission('customers.manage')], async (req, res) => {
    const { file, fields } = await readMultipart(req, { maxBytes: CUSTOMER_CSV_MAX_BYTES + 512 * 1024, maxFields: 4, maxParts: 5,
      allowedFields: ['expectedHash', 'onDuplicate', 'confirmUpdateCount', 'skipInvalidRows'] });
    if (file.bytes.length > CUSTOMER_CSV_MAX_BYTES) throw AppError.badRequest('file_too_large', 'CSV must be under 5 MB.');
    if (file.bytes.includes(0)) throw AppError.badRequest('csv_not_text', 'This does not look like a CSV text file.');
    let csv;
    try { csv = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
    catch { throw AppError.badRequest('csv_not_utf8', 'Save your file as CSV UTF-8.'); }
    const skipInvalidRows = fields.skipInvalidRows === undefined || fields.skipInvalidRows === 'false' ? false
      : fields.skipInvalidRows === 'true' ? true : null;
    if (skipInvalidRows === null) throw AppError.badRequest('validation_failed', 'SkipInvalidRows must be true or false.');
    const confirmUpdateCount = fields.confirmUpdateCount === undefined || fields.confirmUpdateCount === '' ? null : Number(fields.confirmUpdateCount);
    if (confirmUpdateCount !== null && (!Number.isSafeInteger(confirmUpdateCount) || confirmUpdateCount < 0)) {
      throw AppError.badRequest('validation_failed', 'ConfirmUpdateCount must be a non-negative integer.');
    }
    const result = await commitCustomerImport(pool, req.currentUser, csv, {
      expectedHash: fields.expectedHash ?? '', onDuplicate: fields.onDuplicate ?? 'skip', confirmUpdateCount, skipInvalidRows,
    });
    return res.status(200).json(result);
  });

  router.get('/search', uploadLimit, ...requireSearchAuth, async (req, res) =>
    res.status(200).json(await searchBusiness(pool, req.currentUser, req.query.q, req.query.limit ?? '5')));

  const sendPdf = (res, file) => res.status(200).type('application/pdf').attachment(file.fileName).send(file.content);
  router.get('/invoices/:id/pdf', ...[requireBearerAuth(env, pool), requirePermission('invoices.view')], async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('invoice_not_found', 'Invoice not found.');
    return sendPdf(res, await invoicePdf(pool, req.currentUser, storage, req.params.id));
  });
  router.get('/invoices/:id/credit-notes/:creditNoteId/pdf', ...[requireBearerAuth(env, pool), requirePermission('invoices.view')], async (req, res) => {
    if (!UUID.test(req.params.id) || !UUID.test(req.params.creditNoteId)) throw AppError.notFound('credit_note_not_found', 'Credit note not found.');
    return sendPdf(res, await invoicePdf(pool, req.currentUser, storage, req.params.id, req.params.creditNoteId));
  });
  router.get('/orders/:id/quotation-pdf', ...[requireBearerAuth(env, pool), requirePermission('orders.view')], async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('order_not_found', 'Order not found.');
    return sendPdf(res, await quotationPdf(pool, req.currentUser, storage, req.params.id));
  });
  router.get('/customers/:customerId/measurement-sets/:setId/pdf', ...[requireBearerAuth(env, pool), requirePermission('customers.view')], async (req, res) => {
    if (!UUID.test(req.params.customerId) || !UUID.test(req.params.setId)) throw AppError.notFound('measurement_set_not_found', 'Measurement profile not found.');
    return sendPdf(res, await measurementPdf(pool, req.currentUser, storage, req.params.customerId, req.params.setId));
  });
  router.get('/tasks/:id/job-sheet-pdf', ...[requireBearerAuth(env, pool), requirePermission('tasks.view')], async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('task_not_found', 'Task not found.');
    return sendPdf(res, await jobSheetPdf(pool, req.currentUser, storage, req.params.id));
  });
  router.get('/my/tasks/:id/job-sheet-pdf', ...[requireBearerAuth(env, pool), requirePermission('tasks.work')], async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('task_not_found', 'Task not found.');
    return sendPdf(res, await jobSheetPdf(pool, req.currentUser, storage, req.params.id, true));
  });

  return router;
}

export function createPublicMediaRouter({ env, pool, storage }) {
  const router = Router();
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
  router.get('/public/media/:id/:variant', publicLimit, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.notFound('media_not_found', 'Image not found.');
    const file = await openMedia(pool, storage, null, req.params.id, req.params.variant, true);
    res.set('cache-control', 'public, max-age=3600').set('x-content-type-options', 'nosniff');
    res.status(200).type(file.contentType);
    file.content.on('error', (error) => res.destroy(error));
    return file.content.pipe(res);
  });
  return router;
}
