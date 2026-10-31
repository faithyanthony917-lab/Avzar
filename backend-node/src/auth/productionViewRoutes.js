import { Router } from 'express';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { getMyToday } from './workerTodayService.js';
import {
  getLeaveConflicts, getProductionCalendar, getProductionOverview, getWorkload, productionViewLocations,
} from './productionViewService.js';

// Step-12a: read-only manager views over production work. All four need tasks.view; workload and calendar also need the
// `scheduling.shop` plan feature (checked in the service). Results are limited to the caller's business and locations.
export function createProductionViewRouter({ env, pool }) {
  const router = Router();
  const requireTasksView = [requireBearerAuth(env, pool), requirePermission('tasks.view')];

  router.get('/production/overview', ...requireTasksView, async (req, res) => {
    const allowed = await productionViewLocations(pool, req.currentUser);
    return res.status(200).json(await getProductionOverview(pool, req.currentUser, allowed));
  });

  router.get('/production/workload', ...requireTasksView, async (req, res) => {
    const allowed = await productionViewLocations(pool, req.currentUser);
    return res.status(200).json(await getWorkload(pool, req.currentUser, allowed, req.query));
  });

  router.get('/production/calendar', ...requireTasksView, async (req, res) => {
    const allowed = await productionViewLocations(pool, req.currentUser);
    return res.status(200).json(await getProductionCalendar(pool, req.currentUser, allowed, req.query));
  });

  router.get('/production/leave-conflicts', ...requireTasksView, async (req, res) => {
    const allowed = await productionViewLocations(pool, req.currentUser);
    return res.status(200).json(await getLeaveConflicts(pool, req.currentUser, allowed));
  });

  // Step-12c: the signed-in worker's own planned work for today and their own leave. Needs tasks.work; only the caller's rows.
  const requireTasksWork = [requireBearerAuth(env, pool), requirePermission('tasks.work')];
  router.get('/my/today', ...requireTasksWork, async (req, res) => res.status(200).json(await getMyToday(pool, req.currentUser)));

  return router;
}
