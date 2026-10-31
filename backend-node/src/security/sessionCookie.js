export const SESSION_COOKIE = 'tailoring.session';

function cookieOptions(env) {
  return `Path=/; HttpOnly; SameSite=Lax${env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export function setSessionCookie(res, token, env) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions(env)}`);
}

export function clearSessionCookie(res, env) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(env)}; Max-Age=0`);
}