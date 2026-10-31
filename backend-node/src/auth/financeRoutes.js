import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import {
  createExpense,
  exportExpenses,
  getExpense,
  listExpenseCategories,
  listExpenses,
  saveExpenseCategory,
  summarizeExpenses,
  updateExpense,
  voidExpense,
} from './expenseService.js';
import {
  createInvoice,
  createInvoiceFromOrder,
  addInvoiceCreditNote,
  deleteDraftInvoice,
  getInvoice,
  issueDraftInvoice,
  listInvoices,
  updateDraftInvoice,
  voidInvoice,
} from './invoiceService.js';
import {
  getPayment,
  getReceipt,
  getReceiptForPayment,
  listPayments,
  recordPayment,
  rejectPayment,
  reversePayment,
  verifyPayment,
} from './paymentService.js';
import { createReceiptPdf } from './receiptPdfService.js';

const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().min(0.01).max(100_000).default(1),
  unitPrice: z.number().min(0).max(1_000_000_000).default(0),
  discount: z.number().min(0).max(1_000_000_000).default(0),
  taxPercent: z.number().min(0).max(100).nullable().optional(),
});

const invoiceSchema = z.object({
  customerId: z.string().uuid(),
  lines: z.array(invoiceLineSchema).min(1).max(100),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  taxPercent: z.number().min(0).max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional(),
});

const invoiceFromOrderSchema = z.object({
  mode: z.string().trim().default('Full'),
  depositPercent: z.number().min(0.01).max(99.99).nullable().optional(),
  depositAmount: z.number().min(0.01).max(1_000_000_000).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  taxPercent: z.number().min(0).max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional(),
});

const updateInvoiceSchema = z.object({
  version: z.number().int().min(0).max(4_294_967_295),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional(),
  lines: z.array(invoiceLineSchema).max(100).optional(),
  taxPercent: z.number().min(0).max(100).nullable().optional(),
});
const voidInvoiceSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const creditNoteSchema = z.object({
  amount: z.number().min(0.01).max(1_000_000_000),
  reason: z.string().trim().min(3).max(500),
});

const paymentSchema = z.object({
  amount: z.number().min(0.01).max(1_000_000_000),
  method: z.string().trim().min(1).max(20),
  reference: z.string().trim().max(100).nullable().optional(),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  verifyNow: z.boolean().default(false),
});
const paymentReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const expenseCategorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

const expenseSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().min(0.01).max(1_000_000_000),
  description: z.string().trim().min(2).max(300),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor: z.string().trim().max(120).optional(),
  reference: z.string().trim().max(100).optional(),
  locationId: z.string().uuid().nullable().optional(),
  version: z.number().int().min(0).max(4_294_967_295).optional(),
});
const voidExpenseSchema = z.object({ reason: z.string().trim().min(3).max(500) });

function transaction(pool, callback) {
  return pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}

async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`
    SELECT DISTINCT ml."LocationId"
    FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`,
  [user.userId, user.businessId]);
  return rows.map((row) => row.LocationId);
}

const isUuid = (value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function parseExpenseDateQuery(value, name) {
  if (value === undefined) return undefined;
  const result = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))
      || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) {
    throw AppError.badRequest(`invalid_${name}`, `${name} must be a valid date in YYYY-MM-DD format.`);
  }
  return result;
}

function expenseListQuery(req) {
  const page = Number.parseInt(req.query.page ?? '1', 10);
  const pageSize = Number.parseInt(req.query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  const query = { page, pageSize, includeVoid: false };
  for (const field of ['categoryId', 'locationId']) {
    if (req.query[field] !== undefined) {
      if (!isUuid(String(req.query[field]))) throw AppError.badRequest(`invalid_${field}`, `The ${field} is invalid.`);
      query[field] = String(req.query[field]);
    }
  }
  query.from = parseExpenseDateQuery(req.query.from, 'from');
  query.to = parseExpenseDateQuery(req.query.to, 'to');
  if (query.from && query.to && query.from > query.to) {
    throw AppError.badRequest('invalid_date_range', 'The from date must not be later than the to date.');
  }
  if (req.query.includeVoid !== undefined) {
    if (!['true', 'false'].includes(String(req.query.includeVoid))) {
      throw AppError.badRequest('invalid_include_void', 'includeVoid must be true or false.');
    }
    query.includeVoid = String(req.query.includeVoid) === 'true';
  }
  if (req.query.search !== undefined) query.search = String(req.query.search).trim().slice(0, 200);
  return query;
}

function invoiceListQuery(req) {
  const page = Number.parseInt(req.query.page ?? '1', 10);
  const pageSize = Number.parseInt(req.query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  const query = { page, pageSize };
  for (const field of ['customerId', 'orderId']) {
    if (req.query[field] !== undefined) {
      if (!isUuid(String(req.query[field]))) throw AppError.badRequest(`invalid_${field}`, `The ${field} is invalid.`);
      query[field] = String(req.query[field]);
    }
  }
  query.from = parseExpenseDateQuery(req.query.from, 'from');
  query.to = parseExpenseDateQuery(req.query.to, 'to');
  if (query.from && query.to && query.from > query.to) {
    throw AppError.badRequest('invalid_date_range', 'The from date must not be later than the to date.');
  }
  for (const field of ['outstanding', 'overdue']) {
    if (req.query[field] !== undefined) {
      if (!['true', 'false'].includes(String(req.query[field]))) {
        throw AppError.badRequest(`invalid_${field}`, `${field} must be true or false.`);
      }
      query[field] = String(req.query[field]) === 'true';
    }
  }
  if (req.query.status !== undefined) query.status = String(req.query.status).trim();
  if (req.query.search !== undefined) query.search = String(req.query.search).trim().slice(0, 200);
  return query;
}

function paymentListQuery(req) {
  const page = Number.parseInt(req.query.page ?? '1', 10);
  const pageSize = Number.parseInt(req.query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  const query = { page, pageSize };
  for (const field of ['invoiceId', 'customerId']) {
    if (req.query[field] !== undefined) {
      if (!isUuid(String(req.query[field]))) throw AppError.badRequest(`invalid_${field}`, `The ${field} is invalid.`);
      query[field] = String(req.query[field]);
    }
  }
  query.from = parseExpenseDateQuery(req.query.from, 'from');
  query.to = parseExpenseDateQuery(req.query.to, 'to');
  if (query.from && query.to && query.from > query.to) {
    throw AppError.badRequest('invalid_date_range', 'The from date must not be later than the to date.');
  }
  if (req.query.status !== undefined) query.status = String(req.query.status).trim();
  return query;
}

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export function createFinanceRouter({ env, pool }) {
  const router = Router();

  const requireInvoiceView = [requireBearerAuth(env, pool), requirePermission('invoices.view')];
  const requireInvoiceManage = [requireBearerAuth(env, pool), requirePermission('invoices.manage')];
  const requirePaymentView = [requireBearerAuth(env, pool), requirePermission('payments.view')];
  const requirePaymentRecord = [requireBearerAuth(env, pool), requirePermission('payments.record')];
  const requirePaymentVerify = [requireBearerAuth(env, pool), requirePermission('payments.verify')];
  const requireExpensesView = [requireBearerAuth(env, pool), requirePermission('expenses.view')];
  const requireExpensesManage = [requireBearerAuth(env, pool), requirePermission('expenses.manage')];

  router.get('/invoices', ...requireInvoiceView, async (req, res) => {
    return res.status(200).json(await listInvoices(pool, req.currentUser, invoiceListQuery(req),
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/invoices/:id', ...requireInvoiceView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    return res.status(200).json(await getInvoice(pool, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/invoices', ...requireInvoiceManage, async (req, res) => {
    const payload = parse(invoiceSchema, req.body);
    const result = await createInvoice(pool, transaction, req.currentUser, payload, req.get('Idempotency-Key'),
      await allowedLocations(pool, req.currentUser));
    return res.status(result.created ? 201 : 200).json(result.invoice);
  });

  router.post('/invoices/from-order/:orderId', ...requireInvoiceManage, async (req, res) => {
    if (!isUuid(req.params.orderId)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const payload = parse(invoiceFromOrderSchema, req.body);
    const result = await createInvoiceFromOrder(pool, transaction, req.currentUser, req.params.orderId,
      payload, req.get('Idempotency-Key'), await allowedLocations(pool, req.currentUser));
    return res.status(result.created ? 201 : 200).json(result.invoice);
  });

  router.put('/invoices/:id', ...requireInvoiceManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    const payload = parse(updateInvoiceSchema, req.body);
    return res.status(200).json(await updateDraftInvoice(pool, transaction, req.currentUser, req.params.id,
      payload, await allowedLocations(pool, req.currentUser)));
  });

  router.delete('/invoices/:id', ...requireInvoiceManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    await deleteDraftInvoice(pool, transaction, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser));
    return res.status(204).end();
  });

  router.post('/invoices/:id/issue', ...requireInvoiceManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    return res.status(200).json(await issueDraftInvoice(pool, transaction, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/invoices/:id/void', ...requireInvoiceManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    const { reason } = parse(voidInvoiceSchema, req.body);
    return res.status(200).json(await voidInvoice(pool, transaction, req.currentUser, req.params.id, reason,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/invoices/:id/credit-notes', ...requireInvoiceManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    const payload = parse(creditNoteSchema, req.body);
    return res.status(200).json(await addInvoiceCreditNote(pool, transaction, req.currentUser, req.params.id,
      payload, await allowedLocations(pool, req.currentUser)));
  });

  router.post('/invoices/:id/payments', ...requirePaymentRecord, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    const payload = parse(paymentSchema, req.body);
    const result = await recordPayment(pool, transaction, req.currentUser, req.params.id, payload,
      req.get('Idempotency-Key'), await allowedLocations(pool, req.currentUser));
    return res.status(result.created ? 201 : 200).json(result.payment);
  });

  router.get('/payments', ...requirePaymentView, async (req, res) => {
    return res.status(200).json(await listPayments(pool, req.currentUser, paymentListQuery(req),
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/payments/:id', ...requirePaymentView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_payment_id', 'The payment ID is invalid.');
    return res.status(200).json(await getPayment(pool, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/payments/:id/verify', ...requirePaymentVerify, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_payment_id', 'The payment ID is invalid.');
    return res.status(200).json(await verifyPayment(pool, transaction, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/payments/:id/reject', ...requirePaymentVerify, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_payment_id', 'The payment ID is invalid.');
    const { reason } = parse(paymentReasonSchema, req.body);
    return res.status(200).json(await rejectPayment(pool, transaction, req.currentUser, req.params.id, reason,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/payments/:id/reverse', ...requirePaymentVerify, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_payment_id', 'The payment ID is invalid.');
    const { reason } = parse(paymentReasonSchema, req.body);
    return res.status(200).json(await reversePayment(pool, transaction, req.currentUser, req.params.id, reason,
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/payments/:id/receipt', ...requirePaymentView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_payment_id', 'The payment ID is invalid.');
    return res.status(200).json(await getReceiptForPayment(pool, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/receipts/:id', ...requirePaymentView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_receipt_id', 'The receipt ID is invalid.');
    return res.status(200).json(await getReceipt(pool, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/receipts/:id/pdf', ...requirePaymentView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_receipt_id', 'The receipt ID is invalid.');
    const pdf = await createReceiptPdf(pool, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser));
    return res.status(200)
      .set({
        'cache-control': 'private, no-store',
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${pdf.fileName}"`,
      })
      .send(pdf.content);
  });

  router.get('/expense-categories', ...requireExpensesView, async (req, res) => {
    return res.status(200).json(await listExpenseCategories(pool, req.currentUser));
  });

  router.post('/expense-categories', ...requireExpensesManage, async (req, res) => {
    const payload = parse(expenseCategorySchema, req.body);
    return res.status(201).json(await saveExpenseCategory(pool, transaction, req.currentUser, null, payload));
  });

  router.put('/expense-categories/:id', ...requireExpensesManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_category_id', 'The category ID is invalid.');
    const payload = parse(expenseCategorySchema, req.body);
    return res.status(200).json(await saveExpenseCategory(pool, transaction, req.currentUser, req.params.id, payload));
  });

  router.get('/expenses/export', ...requireExpensesView, async (req, res) => {
    const query = expenseListQuery(req);
    const csv = await exportExpenses(pool, req.currentUser, query, await allowedLocations(pool, req.currentUser));
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    res.setHeader('content-disposition', `attachment; filename="expenses-${date}.csv"`);
    return res.status(200).type('text/csv; charset=utf-8').send(csv);
  });

  router.get('/expenses', ...requireExpensesView, async (req, res) => {
    return res.status(200).json(await listExpenses(pool, req.currentUser, expenseListQuery(req),
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/expenses/summary', ...requireExpensesView, async (req, res) => {
    const from = parseExpenseDateQuery(req.query.from, 'from');
    const to = parseExpenseDateQuery(req.query.to, 'to');
    if (from && to && from > to) throw AppError.badRequest('invalid_date_range', 'The from date must not be later than the to date.');
    let locationId;
    if (req.query.locationId !== undefined) {
      if (!isUuid(String(req.query.locationId))) throw AppError.badRequest('invalid_location_id', 'The location ID is invalid.');
      locationId = String(req.query.locationId);
    }
    return res.status(200).json(await summarizeExpenses(pool, req.currentUser, { from, to, locationId },
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/expenses/:id', ...requireExpensesView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_expense_id', 'The expense ID is invalid.');
    return res.status(200).json(await getExpense(pool, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/expenses', ...requireExpensesManage, async (req, res) => {
    const payload = parse(expenseSchema, req.body);
    return res.status(201).json(await createExpense(pool, transaction, req.currentUser, payload,
      await allowedLocations(pool, req.currentUser)));
  });

  router.put('/expenses/:id', ...requireExpensesManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_expense_id', 'The expense ID is invalid.');
    const payload = parse(expenseSchema, req.body);
    return res.status(200).json(await updateExpense(pool, transaction, req.currentUser, req.params.id, payload,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/expenses/:id/void', ...requireExpensesManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_expense_id', 'The expense ID is invalid.');
    const { reason } = parse(voidExpenseSchema, req.body);
    await voidExpense(pool, transaction, req.currentUser, req.params.id, reason,
      await allowedLocations(pool, req.currentUser));
    return res.status(200).json(await getExpense(pool, req.currentUser, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  return router;
}
