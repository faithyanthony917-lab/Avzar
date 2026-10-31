import { Router } from 'express';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { allowedLocations, reportSummary } from './reportsService.js';
import { reconciliationReport } from './reconciliationService.js';

export function createReportsRouter({ env, pool }) {
  const router = Router();
  router.get('/reports/summary', requireBearerAuth(env, pool), requirePermission('reports.view'), async (req, res) => {
    return res.status(200).json(await reportSummary(pool, req.currentUser, req.query.from, req.query.to));
  });
  // Step 15c: payment reconciliation. Needs both report access and payment access, because it lists individual payments.
  router.get('/reports/reconciliation', requireBearerAuth(env, pool), requirePermission('reports.view'), requirePermission('payments.view'), async (req, res) => {
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await reconciliationReport(pool, req.currentUser, allowed, req.query.from, req.query.to));
  });
  return router;
}