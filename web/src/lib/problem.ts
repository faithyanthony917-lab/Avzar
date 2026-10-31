/** An API error: RFC 7807 problem details from the backend, plus ASP.NET validation errors keyed by field. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly fields: Record<string, string[]> = {},
    public readonly body: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

const GENERIC: Record<number, string> = {
  401: 'You are not signed in, or your session has expired.',
  403: 'You do not have permission to do that.',
  404: 'Not found.',
  409: 'That conflicts with the current state. Reload and try again.',
  423: 'Too many failed attempts. Try again later.',
  429: 'Too many attempts. Wait a minute and try again.',
};

/** Builds an ApiError from a failed response. Never throws, even for empty or non-JSON bodies. */
export async function readProblem(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  const fields: Record<string, string[]> = {};
  if (obj.errors && typeof obj.errors === 'object') {
    for (const [k, v] of Object.entries(obj.errors as Record<string, unknown>)) {
      if (Array.isArray(v)) fields[lowerFirst(k)] = v.filter((x): x is string => typeof x === 'string');
    }
  }
  const title = typeof obj.title === 'string' && obj.title ? obj.title : undefined;
  const hasFields = Object.keys(fields).length > 0;
  let message: string;
  if (res.status >= 500) message = res.status === 503 && title ? title : 'Something went wrong on our side. Try again in a moment.';
  else if (hasFields) message = 'Please fix the highlighted fields.';
  else message = (code && title) || GENERIC[res.status] || title || 'The request could not be completed.';
  return new ApiError(res.status, message, code, fields, body);
}

/** A message that is safe to show to a person. */
export function messageFor(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Could not reach the server. Check your connection and try again.';
}
