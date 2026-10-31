import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { createBillingProvider } from './billingProvider.js';
import {
  getPaymentAccount, handleInvoicePaymentWebhook, INVOICE_PAYMENT_WEBHOOK_PATH, listInvoicePaymentAttempts, listPaymentBanks,
  portalContextForToken, savePaymentAccount, startInvoicePayment,
} from './invoicePaymentService.js';
import { allowedLocations } from './quotationService.js';

export { INVOICE_PAYMENT_WEBHOOK_PATH };
export const PORTAL_INVOICE_PAY_PATH = '/api/customer-portal/invoices/pay';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const amountSchema = z.number().finite().positive().max(1_000_000_000).optional();
const startBody = z.object({ amount: amountSchema }).strict();
const portalBody = z.object({ token: z.string().min(1).max(200), invoiceId: z.string().uuid(), amount: amountSchema }).strict();
const accountBody = z.object({ bankCode: z.string().trim().min(1).max(10), accountNumber: z.string().trim().min(1).max(20) }).strict();

function parse(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export function createInvoicePaymentRouter({ env, pool, billingProvider = createBillingProvider(env) }) {
  const router = Router();
  const auth = requireBearerAuth(env, pool);
  const startLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const requireSettings = [auth, requirePermission('business.settings')];
  const requireRecord = [auth, requirePermission('payments.record')];
  const requireView = [auth, requirePermission('payments.view')];
  // Where Paystack sends the customer after paying. The page carries no token: it only says the payment is being confirmed.
  const callbackUrl = () => {
    const base = env.PUBLIC_BASE_URL ?? env.WEB_BASE_URL;
    return base ? new URL('/customer-portal?payment=complete', base).toString() : undefined;
  };
  const invoiceId = (req) => {
    if (!UUID.test(req.params.id)) throw AppError.badRequest('invalid_invoice_id', 'The invoice ID is invalid.');
    return req.params.id;
  };

  router.get('/business/payment-account', ...requireSettings, async (req, res) =>
    res.status(200).json(await getPaymentAccount(pool, req.currentUser)));
  router.get('/business/payment-account/banks', ...requireSettings, async (_req, res) =>
    res.status(200).json(await listPaymentBanks(billingProvider)));
  router.put('/business/payment-account', startLimit, ...requireSettings, async (req, res) =>
    res.status(200).json(await savePaymentAccount(pool, billingProvider, req.currentUser, parse(accountBody, req.body))));

  router.post('/invoices/:id/online-payment', startLimit, ...requireRecord, async (req, res) => {
    const id = invoiceId(req);
    const body = parse(startBody, req.body);
    const user = req.currentUser;
    const result = await startInvoicePayment(pool, billingProvider,
      { businessId: user.businessId, userId: user.userId, allowed: await allowedLocations(pool, user) }, id,
      { amount: body.amount, idempotencyKey: req.get('Idempotency-Key'), callbackUrl: callbackUrl() });
    return res.status(result.created ? 201 : 200).json(result);
  });
  router.get('/invoices/:id/online-payments', ...requireView, async (req, res) =>
    res.status(200).json(await listInvoicePaymentAttempts(pool, req.currentUser, invoiceId(req), await allowedLocations(pool, req.currentUser))));

  // Public: the portal token is the credential (CSRF is exempt for exactly this path and the webhook).
  router.post('/customer-portal/invoices/pay', publicLimit, async (req, res) => {
    const body = parse(portalBody, req.body);
    const portal = await portalContextForToken(pool, body.token);
    const result = await startInvoicePayment(pool, billingProvider, { businessId: portal.businessId, customerId: portal.customerId }, body.invoiceId, { amount: body.amount, callbackUrl: callbackUrl() });
    return res.status(result.created ? 201 : 200).json(result);
  });

  router.post('/invoice-payments/webhook', async (req, res) => {
    const status = await handleInvoicePaymentWebhook(pool, billingProvider, req.rawBody, req.get('x-paystack-signature') ?? '');
    return res.status(status).end();
  });
  return router;
}
