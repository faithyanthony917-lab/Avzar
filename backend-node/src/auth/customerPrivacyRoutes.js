import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { createCustomerPrivacyRequest, listBusinessCustomerPrivacyRequests, listCustomerPrivacyRequests, reviewCustomerPrivacyRequest } from './customerPrivacyService.js';

const tokenSchema = z.object({ token: z.string().min(32).max(128) });
const createSchema = tokenSchema.extend({ type: z.enum(['Export', 'Deletion']), note: z.string().trim().max(500).optional() });
const reviewSchema = z.object({ status: z.enum(['Approved', 'Denied', 'Completed']), staffNote: z.string().trim().max(500).optional() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parse(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export const CUSTOMER_PRIVACY_LIST_PATH = '/api/customer-portal/privacy-requests/list';
export const CUSTOMER_PRIVACY_CREATE_PATH = '/api/customer-portal/privacy-requests';

export function createCustomerPrivacyRouter({ env, pool }) {
  const router = Router();
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const auth = requireBearerAuth(env, pool);
  const manage = [auth, requirePermission('customers.manage')];

  router.post('/customer-portal/privacy-requests/list', publicLimit, async (req, res) => {
    const { token } = parse(tokenSchema, req.body);
    res.set('cache-control', 'no-store');
    return res.status(200).json(await listCustomerPrivacyRequests(pool, token));
  });

  router.post('/customer-portal/privacy-requests', publicLimit, async (req, res) => {
    const payload = parse(createSchema, req.body);
    const result = await createCustomerPrivacyRequest(pool, payload);
    return res.status(result.alreadyPending ? 200 : 201).json(result);
  });

  router.get('/customers/:id/privacy-requests', ...manage, async (req, res) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_customer_id', 'The customer ID is invalid.');
    res.set('cache-control', 'no-store');
    return res.status(200).json(await listBusinessCustomerPrivacyRequests(pool, req.currentUser, req.params.id));
  });

  router.post('/customers/:id/privacy-requests/:requestId/review', ...manage, async (req, res) => {
    if (!UUID.test(req.params.id) || !UUID.test(req.params.requestId)) throw AppError.badRequest('invalid_privacy_request_id', 'The customer or request ID is invalid.');
    return res.status(200).json(await reviewCustomerPrivacyRequest(pool, req.currentUser, req.params.id, req.params.requestId, parse(reviewSchema, req.body)));
  });

  return router;
}
