import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { issueAccessToken } from '../security/jwt.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { clearSessionCookie, setSessionCookie } from '../security/sessionCookie.js';
import { currentUser } from './mobileAuthService.js';
import * as authService from './coreAuthService.js';

const password = z.string().min(10).max(128);
const schemas = {
  register: z.object({
    businessName: z.string().min(2).max(120), ownerName: z.string().min(2).max(120),
    email: z.string().trim().email().max(256), password,
    timeZoneId: z.string().min(1).max(64).default('UTC'), currencyCode: z.string().length(3).default('USD'),
    locationName: z.string().max(120).nullish(),
  }),
  login: z.object({
    email: z.string().trim().email(), password: z.string().min(1), businessId: z.string().uuid().nullable().optional(),
    twoFactorCode: z.string().nullish(), recoveryCode: z.string().nullish(),
  }),
  accept: z.object({ token: z.string().min(1), password }),
  acceptExisting: z.object({ token: z.string().min(1) }),
  switchBusiness: z.object({ businessId: z.string().uuid() }),
};

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

function requireConfigured(env, pool) {
  if (!pool) throw new AppError(503, 'database_not_configured', 'The database is not configured.');
  if (!env.JWT_SIGNING_KEY || env.JWT_SIGNING_KEY.length < 32) {
    throw new AppError(503, 'auth_not_configured', 'Authentication is not configured on this server.');
  }
}

function sendBrowserSession(res, env, tokens, identity, status = 200) {
  const access = issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: 720,
  }, { userId: identity.userId, businessId: identity.businessId, sessionId: tokens.sessionId });
  setSessionCookie(res, access.token, env);
  res.set('cache-control', 'no-store');
  return res.status(status).json(tokens.user);
}

async function signIn(res, env, pool, identity, status = 200) {
  const tokens = await authService.createBrowserSession(pool, env, identity);
  return sendBrowserSession(res, env, tokens, identity, status);
}

export function createCoreAuthRouter({ env, pool, csrfSecret }) {
  const router = Router();
  const authLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const signedIn = requireBearerAuth(env, pool);

  router.get('/auth/csrf', async (_req, res) => {
    const token = await authService.createCsrfToken(csrfSecret);
    const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `tailoring.csrf=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`);
    return res.status(200).json({ token });
  });

  router.post('/auth/register-business', authLimit, async (req, res) => {
    requireConfigured(env, pool);
    const input = parse(schemas.register, req.body);
    const identity = await authService.registerBusiness(pool, input, env);
    return signIn(res, env, pool, identity, 201);
  });

  router.post('/auth/login', authLimit, async (req, res) => {
    requireConfigured(env, pool);
    const input = parse(schemas.login, req.body);
    const result = await authService.authenticateUser(pool, input, env);
    if (!result.businessId) return res.status(409).json({ code: 'choose_business', choices: result.choices });
    return signIn(res, env, pool, result, 200);
  });

  router.post('/auth/accept-invitation', authLimit, async (req, res) => {
    requireConfigured(env, pool);
    const identity = await authService.acceptInvitation(pool, parse(schemas.accept, req.body));
    return signIn(res, env, pool, identity, 200);
  });

  router.post('/auth/accept-invitation/existing', authLimit, signedIn, async (req, res) => {
    requireConfigured(env, pool);
    const identity = await authService.acceptInvitationForExistingUser(pool, req.auth.userId, parse(schemas.acceptExisting, req.body));
    return signIn(res, env, pool, identity, 200);
  });

  router.post('/auth/logout', signedIn, async (req, res) => {
    await authService.revokeBrowserSession(pool, req.auth.userId, req.auth.sessionId);
    clearSessionCookie(res, env);
    return res.status(204).end();
  });

  router.get('/auth/me', signedIn, async (req, res) => {
  const user = await authService.getCurrentUser(pool, req.auth.userId, req.auth.businessId);
    if (!user) throw AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.');
    return res.status(200).json(user);
  });

  router.get('/auth/businesses', signedIn, async (req, res) => {
    const businesses = await authService.listUserBusinesses(pool, req.auth.userId, req.auth.businessId);
    res.set('cache-control', 'no-store');
    return res.status(200).json({ businesses });
  });

  router.post('/auth/switch-business', authLimit, signedIn, async (req, res) => {
    requireConfigured(env, pool);
    if (req.authTransport !== 'cookie') {
      throw AppError.badRequest('browser_session_required', 'Switching business is only available in a browser session.');
    }
    const input = parse(schemas.switchBusiness, req.body);
    if (input.businessId === req.auth.businessId) return res.status(200).json(req.currentUser);
    const { identity, created } = await authService.switchBusiness(pool, env, req.auth, input.businessId);
    return sendBrowserSession(res, env, created, identity, 200);
  });

  return router;
}