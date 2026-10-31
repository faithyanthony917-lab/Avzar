import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { cancelInstallmentPlan, createInstallmentPlan, getInstallmentPlan } from './installmentService.js';
import { allowedLocations } from './quotationService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const note = z.string().trim().max(500).optional();
const equalBody = z.object({
  parts: z.number().int().min(2).max(24),
  firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the first due date as YYYY-MM-DD.'),
  interval: z.enum(['weekly', 'monthly']),
  note,
}).strict();
const customBody = z.object({
  installments: z.array(z.object({
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the due date as YYYY-MM-DD.'),
    amount: z.number().finite().positive().max(1_000_000_000),
  }).strict()).min(2).max(24),
  note,
}).strict();
const cancelBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

function parse(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

// A body that names `installments` is a custom list; anything else is read as equal parts. Choosing by key keeps the errors specific.
const bodySchema = (body) => (body && typeof body === 'object' && 'installments' in body ? customBody : equalBody);

export function createInstallmentRouter({ env, pool }) {
  const router = Router();
  const auth = requireBearerAuth(env, pool);
  const writeLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const requireView = [auth, requirePermission('payments.view')];
  const requireRecord = [auth, requirePermission('payments.record')];
  const invoiceId = (req) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    return req.params.id;
  };

  router.get('/invoices/:id/installment-plan', ...requireView, async (req, res) =>
    res.status(200).json(await getInstallmentPlan(pool, req.currentUser, invoiceId(req), await allowedLocations(pool, req.currentUser))));

  router.post('/invoices/:id/installment-plan', writeLimit, ...requireRecord, async (req, res) => {
    const id = invoiceId(req);
    const body = parse(bodySchema(req.body), req.body);
    const result = await createInstallmentPlan(pool, req.currentUser, id, body, await allowedLocations(pool, req.currentUser));
    return res.status(result.created ? 201 : 200).json(result);
  });

  router.delete('/invoices/:id/installment-plan', writeLimit, ...requireRecord, async (req, res) => {
    const id = invoiceId(req);
    const body = parse(cancelBody, req.body);
    return res.status(200).json(await cancelInstallmentPlan(pool, req.currentUser, id, body.reason, await allowedLocations(pool, req.currentUser)));
  });

  return router;
}
