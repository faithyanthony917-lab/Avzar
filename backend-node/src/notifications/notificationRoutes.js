// /api/notifications: every route acts only on the signed-in person's own notifications in the active business. There is no
// way to name another person or another business, and no permission is needed beyond being an active member
// (notifications are available on every plan).
import { Router } from 'express';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import {
  getPreferences, listNotifications, markAllRead, markRead, membershipIdFor, savePreferences, unreadCount,
} from './notificationService.js';

function parseLimit(value) {
  if (value === undefined) return 20;
  if (!/^\d{1,3}$/.test(String(value)) || Number(value) < 1) throw AppError.badRequest('invalid_limit', 'limit must be a whole number from 1 to 50.');
  return Math.min(50, Number(value));
}

function parseUnread(value) {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw AppError.badRequest('invalid_unread', 'unread must be true or false.');
}

function single(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw AppError.badRequest(`invalid_${name}`, `${name} must be a single value.`);
  return value;
}

export function createNotificationRouter({ env, pool }) {
  const router = Router();
  const auth = requireBearerAuth(env, pool);

  // Resolves who is asking once per request: the membership behind the token in the business named by the token.
  const scope = async (req) => {
    const membershipId = await membershipIdFor(pool, req.currentUser);
    if (!membershipId) throw AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.');
    return { businessId: req.currentUser.businessId, membershipId };
  };

  router.get('/notifications', auth, async (req, res) => {
    const who = await scope(req);
    const category = single(req.query.category, 'category');
    const result = await listNotifications(pool, {
      ...who, unread: parseUnread(single(req.query.unread, 'unread')), category: category ?? null,
      limit: parseLimit(single(req.query.limit, 'limit')), cursor: single(req.query.cursor, 'cursor') ?? null,
    });
    return res.status(200).json(result);
  });

  router.get('/notifications/unread-count', auth, async (req, res) => {
    return res.status(200).json(await unreadCount(pool, await scope(req)));
  });

  router.post('/notifications/read-all', auth, async (req, res) => {
    const category = req.body && typeof req.body === 'object' ? req.body.category : undefined;
    if (category !== undefined && typeof category !== 'string') throw AppError.badRequest('invalid_category', 'Unknown notification category.');
    return res.status(200).json(await markAllRead(pool, { ...(await scope(req)), category: category ?? null }));
  });

  router.post('/notifications/:id/read', auth, async (req, res) => {
    return res.status(200).json(await markRead(pool, { ...(await scope(req)), id: req.params.id }));
  });

  router.get('/notifications/preferences', auth, async (req, res) => {
    const who = await scope(req);
    return res.status(200).json(await getPreferences(pool, { ...who, pushAvailable: Boolean(env.EXPO_ACCESS_TOKEN) }));
  });

  router.put('/notifications/preferences', auth, async (req, res) => {
    return res.status(200).json(await savePreferences(pool, { ...(await scope(req)), body: req.body }));
  });

  return router;
}
