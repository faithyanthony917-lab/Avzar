import { AppError } from '../http/errors.js';
import { issueAccessToken, verifyAccessToken } from './jwt.js';
import { currentUser } from '../auth/mobileAuthService.js';
import { readCookie } from './csrf.js';
import { SESSION_COOKIE, setSessionCookie } from './sessionCookie.js';
import { setTenantRlsContext } from '../db/tenantRlsContext.js';

export function requireBearerAuth(env, pool) {
  const auth = {
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  };
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const bearerToken = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    const cookieToken = /^Bearer\s/i.test(header) ? null : readCookie(req.headers.cookie, SESSION_COOKIE);
    const token = bearerToken ?? cookieToken;
    const identity = token && verifyAccessToken(auth, token);
    if (!identity || !pool) return next(AppError.unauthorized('unauthorized', 'Authentication is required.'));
    try {
      // Bind every subsequent query in this authenticated async request to the signed token's tenant.
      setTenantRlsContext(identity.businessId);
      const { rows } = await pool.query(`
        SELECT 1 FROM "UserSessions" WHERE "Id" = $1 AND "UserId" = $2 AND "RevokedAtUtc" IS NULL AND "AbsoluteExpiresAtUtc" > now() AND "IdleExpiresAtUtc" > now()`,
      [identity.sessionId, identity.userId]);
      if (!rows.length) return next(AppError.unauthorized('unauthorized', 'Authentication is required.'));
      const user = await currentUser(pool, identity.userId, identity.businessId);
      if (!user) return next(AppError.unauthorized('membership_inactive', 'Your membership in this business is no longer active.'));
      req.auth = identity;
      req.authTransport = cookieToken ? 'cookie' : 'bearer';
      req.currentUser = user;
      if (cookieToken) {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        if (claims.exp - Math.floor(Date.now() / 1000) < 6 * 60 * 60) {
          await pool.query(`UPDATE "UserSessions" SET "LastUsedAtUtc" = now(),
            "IdleExpiresAtUtc" = now() + ($3::int * interval '1 day'),
            "AbsoluteExpiresAtUtc" = now() + ($4::int * interval '1 day')
            WHERE "Id" = $1 AND "UserId" = $2 AND "RevokedAtUtc" IS NULL`,
          [identity.sessionId, identity.userId, env.REFRESH_IDLE_DAYS ?? 30, env.REFRESH_ABSOLUTE_DAYS ?? 90]);
          const refreshed = issueAccessToken({ ...auth, accessTokenMinutes: 720 }, identity);
          setSessionCookie(_res, refreshed.token, env);
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}