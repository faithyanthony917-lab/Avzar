import { ApiError, readProblem } from './problem';

const BASE = '/backend';

async function csrfToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/csrf`, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) throw await readProblem(res);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new ApiError(500, 'Could not start a secure session. Reload and try again.');
  return body.token;
}

/** Browser-side API call through the same-origin proxy. Adds the CSRF token to unsafe methods; throws ApiError on any non-2xx. */
export async function api<T = void>(path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; json?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['x-xsrf-token'] = await csrfToken(); // fetch fresh: the token changes after login and logout
    if (init.json !== undefined) headers['content-type'] = 'application/json';
  }
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) throw await readProblem(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}


/** Multipart upload through the same-origin proxy. The browser supplies the multipart boundary. */
export async function apiUpload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { accept: 'application/json', 'x-xsrf-token': await csrfToken() }, credentials: 'same-origin', cache: 'no-store', body: form });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) throw await readProblem(res);
  return (await res.json()) as T;
}
