import { cookies } from 'next/headers';
import type { CurrentUser } from './auth-types';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const SESSION_COOKIE = 'tailoring.session';

async function sessionHeaders(): Promise<Record<string, string> | null> {
  const c = (await cookies()).get(SESSION_COOKIE);
  return c ? { cookie: `${SESSION_COOKIE}=${c.value}`, accept: 'application/json' } : null;
}

/** Server-side: the signed-in user for this request, or null. Only the session cookie is sent to the API. */
export async function getSession(): Promise<CurrentUser | null> {
  const headers = await sessionHeaders();
  if (!headers) return null;
  const res = await fetch(`${API}/api/auth/me`, { headers, cache: 'no-store' });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`API ${res.status} for /api/auth/me`);
  return (await res.json()) as CurrentUser;
}

/** `code` is the API's stable error code (for example `feature_not_in_plan`) when the failed response carried one. */
export type ServerResult<T> = { ok: true; data: T } | { ok: false; status: number; code?: string };

async function problemCode(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await res.text());
    const code = body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Server-side GET for a signed-in page. Failures come back as a status so the page can show "no access" or "try again" instead of crashing. */
export async function serverGet<T>(path: string): Promise<ServerResult<T>> {
  const headers = await sessionHeaders();
  if (!headers) return { ok: false, status: 401 };
  try {
    const res = await fetch(`${API}${path}`, { headers, cache: 'no-store' });
    if (!res.ok) return { ok: false, status: res.status, code: await problemCode(res) };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 502 };
  }
}
