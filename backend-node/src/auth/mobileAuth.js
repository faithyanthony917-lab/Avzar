import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { issueAccessToken } from '../security/jwt.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { membershipIdFor, registerPushToken, revokePushToken } from '../notifications/notificationService.js';
import { authenticate, createMobileSession, currentUser, revokeMobileSession, rotateMobileSession } from './mobileAuthService.js';

const loginSchema = z.object({
  email: z.string().trim().email().max(256),
  password: z.string().min(1).max(128),
  businessId: z.string().uuid().nullable().optional(),
  twoFactorCode: z.string().max(12).optional(),
  recoveryCode: z.string().max(80).optional(),
  deviceName: z.string().max(80).optional(),
});
const refreshSchema = z.object({ refreshToken: z.string().min(1).max(200) });
const pushTokenSchema = z.object({
  token: z.string().trim().min(1).max(200),
  platform: z.enum(['ios', 'android', 'web']).default('ios'),
  deviceName: z.string().trim().max(80).optional(),
}).strict();

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

function authOptions(env) {
  return {
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  };
}

function requireMobileAuth(env, pool) {
  if (!env.JWT_SIGNING_KEY || env.JWT_SIGNING_KEY.length < 32) {
    throw new AppError(503, 'mobile_auth_not_configured', 'Mobile sign-in is not enabled on this server.');
  }
  if (!pool) throw new AppError(503, 'database_not_configured', 'The database is not configured.');
}

function tokenResponse(env, identity, tokens, user) {
  const access = issueAccessToken(authOptions(env), identity);
  return {
    accessToken: access.token,
    accessExpiresAtUtc: access.expiresAtUtc,
    refreshToken: tokens.refreshToken,
    refreshExpiresAtUtc: tokens.refreshExpiresAtUtc,
    user,
  };
}

export function createMobileAuthRouter({ env, pool }) {
  const router = Router();
  const authLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  router.post('/auth/token', authLimit, async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    requireMobileAuth(env, pool);
    const input = parse(loginSchema, req.body);
    const result = await authenticate(pool, input, env);
    if (!result.businessId) return res.status(409).json({ code: 'choose_business', choices: result.choices });
    const tokens = await createMobileSession(pool, result.userId, result.businessId, input.deviceName, env);
    const user = await currentUser(pool, result.userId, result.businessId);
    if (!user) throw AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.');
    return res.status(200).json(tokenResponse(env, { userId: result.userId, businessId: result.businessId, sessionId: tokens.sessionId }, tokens, user));
  });

  router.post('/auth/token/refresh', authLimit, async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    requireMobileAuth(env, pool);
    const { refreshToken } = parse(refreshSchema, req.body);
    const tokens = await rotateMobileSession(pool, refreshToken, env);
    const user = await currentUser(pool, tokens.userId, tokens.businessId);
    if (!user) throw AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.');
    return res.status(200).json(tokenResponse(env, tokens, tokens, user));
  });

  router.post('/auth/token/revoke', authLimit, async (req, res) => {
    requireMobileAuth(env, pool);
    const { refreshToken } = parse(refreshSchema, req.body);
    await revokeMobileSession(pool, refreshToken);
    return res.status(204).end();
  });

  router.post('/auth/push-token', authLimit, requireBearerAuth(env, pool), async (req, res) => {
    requireMobileAuth(env, pool);
    const membershipId = await membershipIdFor(pool, req.currentUser);
    if (!membershipId) throw AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.');
    const payload = parse(pushTokenSchema, req.body);
    await registerPushToken(pool, { businessId: req.currentUser.businessId, membershipId, sessionId: req.auth.sessionId, ...payload });
    return res.status(204).end();
  });

  router.delete('/auth/push-token', authLimit, requireBearerAuth(env, pool), async (req, res) => {
    requireMobileAuth(env, pool);
    const membershipId = await membershipIdFor(pool, req.currentUser);
    if (!membershipId) throw AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.');
    const payload = parse(pushTokenSchema, req.body);
    await revokePushToken(pool, { businessId: req.currentUser.businessId, membershipId, sessionId: req.auth.sessionId, token: payload.token });
    return res.status(204).end();
  });

  return router;
}