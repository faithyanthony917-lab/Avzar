import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { issueAccessToken } from '../security/jwt.js';
import { clearSessionCookie, setSessionCookie } from '../security/sessionCookie.js';
import { createBrowserSession } from './coreAuthService.js';
import * as account from './accountService.js';

const password = z.string().min(10).max(128);
const schemas = {
  confirmEmail: z.object({ userId: z.string().uuid(), token: z.string().min(1).max(2000) }),
  forgot: z.object({ email: z.string().trim().email().max(256) }),
  reset: z.object({ userId: z.string().uuid(), token: z.string().min(1).max(2000), newPassword: password }),
  change: z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }),
  enable2fa: z.object({ code: z.string().min(6).max(12) }),
  disable2fa: z.object({ password: z.string().min(1).max(128), code: z.string().max(12).nullish(), recoveryCode: z.string().max(80).nullish() }),
  deleteAccount: z.object({ password: z.string().min(1).max(128), twoFactorCode: z.string().max(12).nullish(), recoveryCode: z.string().max(80).nullish() }),
  sessionId: z.string().uuid(),
};

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

export function createAccountRouter({ env, pool }) {
  const router = Router();
  const authLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const needDb = (_req, _res, next) => (pool ? next() : next(new AppError(503, 'database_not_configured', 'The database is not configured.')));
  const signedIn = requireBearerAuth(env, pool);

  // Public recovery endpoints.
  router.post('/auth/confirm-email', authLimit, needDb, async (req, res) => {
    await account.confirmEmail(pool, env, parse(schemas.confirmEmail, req.body));
    res.status(204).end();
  });
  router.post('/auth/forgot-password', authLimit, async (req, res) => {
    const { email } = parse(schemas.forgot, req.body);
    if (pool) await account.requestPasswordReset(pool, env, email); // always 202: never reveals whether the address has an account
    res.status(202).json({ status: 'accepted' });
  });
  router.post('/auth/reset-password', authLimit, needDb, async (req, res) => {
    await account.resetPassword(pool, env, parse(schemas.reset, req.body));
    res.status(204).end();
  });

  // Signed-in account endpoints. The user id always comes from the verified token, never from the request.
  router.get('/account/security', signedIn, async (req, res) => {
    res.status(200).json(await account.getSecurity(pool, req.currentUser.userId));
  });
  router.post('/account/resend-verification', authLimit, signedIn, async (req, res) => {
    await account.sendEmailVerification(pool, env, req.currentUser.userId);
    res.status(202).json({ status: 'accepted' });
  });
  router.post('/account/change-password', authLimit, signedIn, async (req, res) => {
    await account.changePassword(pool, req.currentUser.userId, req.currentUser.businessId, parse(schemas.change, req.body));
    if (req.authTransport === 'cookie') {
      const tokens = await createBrowserSession(pool, env, req.auth);
      const access = issueAccessToken({
        jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: 720,
      }, { userId: req.auth.userId, businessId: req.auth.businessId, sessionId: tokens.sessionId });
      setSessionCookie(res, access.token, env);
    }
    res.status(204).end();
  });
  router.post('/account/two-factor/setup', authLimit, signedIn, async (req, res) => {
    res.set('cache-control', 'no-store').status(200).json(await account.beginTwoFactorSetup(pool, env, req.currentUser.userId));
  });
  router.post('/account/two-factor/enable', authLimit, signedIn, async (req, res) => {
    const body = parse(schemas.enable2fa, req.body);
    res.set('cache-control', 'no-store').status(200).json(await account.enableTwoFactor(pool, req.currentUser.userId, req.currentUser.businessId, body));
  });
  router.post('/account/two-factor/disable', authLimit, signedIn, async (req, res) => {
    await account.disableTwoFactor(pool, req.currentUser.userId, req.currentUser.businessId, parse(schemas.disable2fa, req.body));
    res.status(204).end();
  });
  router.get('/account/sessions', signedIn, async (req, res) => {
    res.status(200).json(await account.listSessions(pool, req.currentUser.userId));
  });
  router.delete('/account/sessions/:sessionId', signedIn, async (req, res) => {
    const sessionId = schemas.sessionId.safeParse(req.params.sessionId);
    if (!sessionId.success) throw AppError.notFound('session_not_found', 'Session not found.');
    await account.revokeSessionById(pool, req.currentUser.userId, sessionId.data);
    res.status(204).end();
  });
  router.post('/account/sessions/revoke-all', signedIn, async (req, res) => {
    await account.revokeAllSessionsForUser(pool, req.currentUser.userId);
    res.status(204).end();
  });
  router.get('/account/export', signedIn, async (req, res) => {
    res.set('cache-control', 'no-store').status(200).json(await account.exportAccount(pool, req.currentUser.userId));
  });
  router.post('/account/delete', authLimit, signedIn, async (req, res) => {
    await account.deleteAccount(pool, req.currentUser.userId, req.currentUser.businessId, parse(schemas.deleteAccount, req.body));
    clearSessionCookie(res, env);
    res.status(204).end();
  });

  return router;
}
