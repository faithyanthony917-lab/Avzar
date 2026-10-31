import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { allowedLocations, getQuotationStatus, listPortalQuotations, respondToQuotation, sendQuotation } from './quotationService.js';

export const PORTAL_QUOTATIONS_PATH = '/api/customer-portal/quotations';
export const PORTAL_QUOTATION_RESPOND_PATH = '/api/customer-portal/quotations/respond';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenBody = z.object({ token: z.string().min(1).max(200) });
const respondBody = z.object({
  token: z.string().min(1).max(200),
  orderId: z.string().uuid(),
  quotationId: z.string().uuid(),
  decision: z.enum(['approve', 'decline']),
  note: z.string().trim().max(500).optional(),
});

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export function createQuotationRouter({ env, pool }) {
  const router = Router();
  const sendLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const requireView = [requireBearerAuth(env, pool), requirePermission('orders.view')];
  const requireManage = [requireBearerAuth(env, pool), requirePermission('orders.manage')];
  const orderId = (req) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    return req.params.id;
  };

  router.get('/orders/:id/quotation', ...requireView, async (req, res) => {
    const id = orderId(req);
    return res.status(200).json(await getQuotationStatus(pool, req.currentUser, id, await allowedLocations(pool, req.currentUser)));
  });

  router.post('/orders/:id/quotation/send', sendLimit, ...requireManage, async (req, res) => {
    const id = orderId(req);
    return res.status(200).json(await sendQuotation(pool, env, req.currentUser, id, await allowedLocations(pool, req.currentUser)));
  });

  // Public (the portal token is the credential, as for /customer-portal/access; CSRF is exempt for exactly these two paths).
  router.post('/customer-portal/quotations', publicLimit, async (req, res) =>
    res.status(200).json(await listPortalQuotations(pool, parse(tokenBody, req.body).token)));

  router.post('/customer-portal/quotations/respond', publicLimit, async (req, res) =>
    res.status(200).json(await respondToQuotation(pool, parse(respondBody, req.body))));

  return router;
}
