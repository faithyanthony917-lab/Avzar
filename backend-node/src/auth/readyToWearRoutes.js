import { Router } from 'express';
import { LIST_CAP, optionalPaging } from './listWindow.js';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { createBillingProvider } from './billingProvider.js';
import { cancelReadyToWearOrder, createReadyToWearCheckout, handleReadyToWearWebhook, listBusinessReadyToWearVariantsWindow, listReadyToWearProducts, upsertReadyToWearVariant } from './readyToWearService.js';

export const READY_TO_WEAR_WEBHOOK_PATH = '/api/ready-to-wear/payment-webhook';
const checkoutSchema = z.object({
  customerName: z.string().trim().min(2).max(120), email: z.string().trim().email().max(254), phone: z.string().trim().max(40).optional(),
  items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
});
const variantSchema = z.object({ id: z.string().uuid().optional(), designId: z.string().uuid(), sku: z.string().trim().min(1).max(80),
  size: z.string().trim().max(40).nullish(), colour: z.string().trim().max(60).nullish(), onHand: z.number().int().min(0).max(1_000_000), isActive: z.boolean().default(true) });

export function createReadyToWearRouter({ env, pool, billingProvider = createBillingProvider(env) }) {
  const router = Router();
  const auth = requireBearerAuth(env, pool);
  const checkoutLimit = rateLimit({ windowMs: 60_000, limit: env.READY_TO_WEAR_CHECKOUT_RATE_LIMIT_PER_MINUTE ?? 10, standardHeaders: true, legacyHeaders: false });
  const write = requirePermission('designs.manage');
  router.get('/public/sites/:slug/ready-to-wear', async (req, res) => {
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/i.test(req.params.slug)) throw AppError.notFound('storefront_not_found', 'Storefront not found.');
    return res.status(200).json(await listReadyToWearProducts(pool, req.params.slug));
  });
  router.post('/public/sites/:slug/ready-to-wear/checkout', checkoutLimit, async (req, res) => {
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/i.test(req.params.slug)) throw AppError.notFound('storefront_not_found', 'Storefront not found.');
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'validation_failed', 'Enter valid customer details and product quantities.');
    const key = req.get('idempotency-key') ?? '';
    return res.status(201).json(await createReadyToWearCheckout(pool, billingProvider, env, req.params.slug, parsed.data, key));
  });
  router.post('/ready-to-wear/payment-webhook', async (req, res) => {
    const status = await handleReadyToWearWebhook(pool, billingProvider, req.rawBody, req.get('x-paystack-signature') ?? '');
    return res.status(status).end();
  });
  router.get('/ready-to-wear/variants', auth, write, async (req, res) => {
    const paging = optionalPaging(req.query);
    const window = paging ? { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize } : { limit: LIST_CAP, offset: 0 };
    const { rows, totalCount } = await listBusinessReadyToWearVariantsWindow(pool, req.currentUser, window);
    // Without paging parameters the first LIST_CAP variants come back, with the total so a screen can say it is showing part of them.
    return res.status(200).json(paging
      ? { items: rows, page: paging.page, pageSize: paging.pageSize, totalCount }
      : { items: rows, totalCount, truncated: totalCount > LIST_CAP });
  });
  router.post('/ready-to-wear/variants', auth, write, async (req, res) => {
    const parsed = variantSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'validation_failed', 'Enter valid product stock details.');
    return res.status(201).json(await upsertReadyToWearVariant(pool, req.currentUser, parsed.data));
  });
  router.post('/ready-to-wear/orders/:id/cancel', auth, requirePermission('orders.manage'), async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.notFound('ready_to_wear_order_not_found', 'Ready-to-wear order not found.');
    return res.status(200).json(await cancelReadyToWearOrder(pool, billingProvider, req.currentUser, req.params.id));
  });
  router.put('/ready-to-wear/variants/:id', auth, write, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.notFound('variant_not_found', 'Variant not found.');
    const parsed = variantSchema.safeParse({ ...req.body, id: req.params.id });
    if (!parsed.success) throw new AppError(400, 'validation_failed', 'Enter valid product stock details.');
    return res.status(200).json(await upsertReadyToWearVariant(pool, req.currentUser, parsed.data));
  });
  return router;
}
