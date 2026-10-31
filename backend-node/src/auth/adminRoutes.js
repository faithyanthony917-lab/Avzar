import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { confirmOwnershipTransfer, getPublicPlans, getTenantEntitlements, listEmailSuppressions, listPlatformPlans, requestOwnershipTransfer, updatePlatformPlan } from './adminService.js';
import { getPlatformBusiness, getPlatformHealth, listPlatformAuditLogs, listPlatformBusinesses, lookupPlatformUser, reactivatePlatformBusiness, suspendPlatformBusiness } from './platformAdminService.js';
import { platformEmails } from './platformAccess.js';
import { listPlatformBackgroundJobs, listPlatformFeatureFlags, retryPlatformNotification, updatePlatformFeatureFlag } from './platformOperationsService.js';

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

const transferRequestSchema = z.object({
  newOwnerMembershipId: z.string().uuid(), password: z.string().min(1).max(128),
  twoFactorCode: z.string().nullish(), recoveryCode: z.string().nullish(),
});
const transferConfirmationSchema = z.object({ token: z.string().min(1).max(128) });
const planUpdateSchema = z.object({
  name: z.string().min(1).max(80), description: z.string().nullish(), isActive: z.boolean(),
  sortOrder: z.number().int(), currencyCode: z.string().length(3), monthlyPrice: z.number().min(0),
  annualPrice: z.number().min(0).nullish(), entitlements: z.record(z.string(), z.string()).default({}),
});
const emailSuppressionQuerySchema = z.object({ q: z.string().optional(), limit: z.coerce.number().int().optional() });
const jobQuerySchema = z.object({ status: z.enum(['Pending','Leased','Sent','Failed','Accepted','Skipped']).optional(), limit: z.coerce.number().int().min(1).max(250).optional() });
const featureFlagSchema = z.object({ enabled: z.boolean() });
const businessListQuerySchema = z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().max(300).optional() });
const userLookupQuerySchema = z.object({ email: z.string().min(3).max(254) });
const auditQuerySchema = z.object({
  action: z.string().max(100).optional(), actor: z.string().max(256).optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().max(300).optional(),
});
const jobRetrySchema = z.object({ kind: z.enum(['notification','push']) });
const suspendSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

export function createAdminRouter({ env, pool }) {
  const router = Router();
  const auth = requireBearerAuth(env, pool);

  router.get('/plans', async (_req, res) => res.status(200).json(await getPublicPlans(pool)));

  router.get('/billing/entitlements', auth, async (req, res) =>
    res.status(200).json(await getTenantEntitlements(pool, req.currentUser.businessId, env)));

  router.post('/business/ownership-transfer', auth, async (req, res) => {
    const request = parse(transferRequestSchema, req.body);
    await requestOwnershipTransfer(pool, env, req.currentUser, request);
    return res.status(202).json({ status: 'verification_sent' });
  });

  router.post('/business/ownership-transfer/confirm', auth, async (req, res) => {
    const { token } = parse(transferConfirmationSchema, req.body);
    await confirmOwnershipTransfer(pool, { ...req.currentUser, token });
    return res.status(204).end();
  });

  router.get('/platform-admin/plans', auth, async (req, res) =>
    res.status(200).json(await listPlatformPlans(pool, req.currentUser.email, platformEmails(env))));

  router.get('/platform-admin/email-suppressions', auth, async (req, res) => {
    const query = parse(emailSuppressionQuerySchema, req.query);
    return res.status(200).json(await listEmailSuppressions(pool, req.currentUser.email, platformEmails(env), query));
  });

  router.get('/platform-admin/feature-flags', auth, async (req, res) =>
    res.status(200).json({ items: await listPlatformFeatureFlags(pool, req.currentUser.email, platformEmails(env)) }));

  router.put('/platform-admin/feature-flags/:key', auth, async (req, res) => {
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(req.params.key)) throw AppError.notFound('feature_flag_not_found', 'Feature flag was not found.');
    const payload = parse(featureFlagSchema, req.body);
    return res.status(200).json(await updatePlatformFeatureFlag(pool, req.currentUser.email, platformEmails(env), req.params.key, payload.enabled));
  });

  router.get('/platform-admin/businesses', auth, async (req, res) =>
    res.status(200).json(await listPlatformBusinesses(pool, req.currentUser.email, platformEmails(env), parse(businessListQuerySchema, req.query))));

  router.get('/platform-admin/businesses/:id', auth, async (req, res) =>
    res.status(200).json(await getPlatformBusiness(pool, req.currentUser.email, platformEmails(env), req.params.id)));

  router.post('/platform-admin/businesses/:id/suspend', auth, async (req, res) =>
    res.status(200).json(await suspendPlatformBusiness(pool, req.currentUser.email, platformEmails(env), req.currentUser.businessId, req.params.id, parse(suspendSchema, req.body).reason)));

  router.post('/platform-admin/businesses/:id/reactivate', auth, async (req, res) =>
    res.status(200).json(await reactivatePlatformBusiness(pool, req.currentUser.email, platformEmails(env), req.params.id)));

  router.get('/platform-admin/users', auth, async (req, res) =>
    res.status(200).json(await lookupPlatformUser(pool, req.currentUser.email, platformEmails(env), parse(userLookupQuerySchema, req.query).email)));

  router.get('/platform-admin/audit-logs', auth, async (req, res) =>
    res.status(200).json(await listPlatformAuditLogs(pool, req.currentUser.email, platformEmails(env), parse(auditQuerySchema, req.query))));

  router.get('/platform-admin/health', auth, async (req, res) =>
    res.status(200).json(await getPlatformHealth(pool, env, req.currentUser.email, platformEmails(env))));

  router.get('/platform-admin/background-jobs', auth, async (req, res) => {
    const query = parse(jobQuerySchema, req.query);
    return res.status(200).json(await listPlatformBackgroundJobs(pool, req.currentUser.email, platformEmails(env), query));
  });

  router.post('/platform-admin/background-jobs/:id/retry', auth, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.notFound('job_not_found', 'Background job was not found.');
    const payload = parse(jobRetrySchema, req.body);
    return res.status(200).json(await retryPlatformNotification(pool, req.currentUser.email, platformEmails(env), payload.kind, req.params.id));
  });

  router.put('/platform-admin/plans/:code', auth, async (req, res) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(req.params.code)) throw AppError.notFound('plan_not_found', 'Plan was not found.');
    const request = parse(planUpdateSchema, req.body);
    await updatePlatformPlan(pool, req.currentUser.email, platformEmails(env), req.params.code, request);
    return res.status(204).end();
  });

  return router;
}