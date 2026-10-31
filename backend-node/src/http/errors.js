// Application errors rendered as RFC 7807 bodies with a stable `code`.
export class AppError extends Error {
  constructor(status, code, message, extensions) {
    super(message);
    this.status = status;
    this.code = code;
    this.extensions = extensions;
  }
  static badRequest = (code, message) => new AppError(400, code, message);
  static unauthorized = (code, message) => new AppError(401, code, message);
  static forbidden = (code, message, extensions) => new AppError(403, code, message, extensions);
  static notFound = (code, message) => new AppError(404, code, message);
  static conflict = (code, message, extensions) => new AppError(409, code, message, extensions);
}

export function problemBody(err) {
  return { type: `https://httpstatuses.io/${err.status}`, title: err.message, status: err.status, code: err.code, ...(err.extensions ?? {}) };
}

// A log-safe description of an error and its causes: type, code, message and stack, never a database `detail` (it can hold customer values).
export function describeError(err, depth = 0) {
  if (!err || typeof err !== 'object') return { message: String(err) };
  const out = { name: err.name, code: err.code, httpStatus: err.$metadata?.httpStatusCode, message: String(err.message ?? err), stack: err.stack };
  if (err.cause && depth < 3) out.cause = describeError(err.cause, depth + 1);
  return out;
}

// Message-free description for background workers: type, code and HTTP status of the error and of each cause (the S3 case).
// A worker has no request to answer, and a message can carry a stored value, so no message and no stack are kept.
export function describeErrorShape(err, depth = 0) {
  if (!err || typeof err !== 'object') return { name: typeof err };
  const out = { name: err.name, code: err.code, httpStatus: err.$metadata?.httpStatusCode };
  if (err.cause && depth < 3) out.cause = describeErrorShape(err.cause, depth + 1);
  return out;
}

// Express 5 error middleware: expected AppErrors become problem+json; anything else is a generic 500 (details logged, never leaked).
export function errorHandler(log = console) {
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof AppError) return res.status(err.status).type('application/problem+json').send(problemBody(err));
     if (err?.type === 'entity.too.large' || err?.status === 413) return res.status(413).type('application/problem+json').send(problemBody(new AppError(413, 'payload_too_large', 'The request body is too large.')));
    if (err?.type === 'entity.parse.failed' || err?.status === 400) return res.status(400).type('application/problem+json').send(problemBody(AppError.badRequest('invalid_json', 'Malformed request body.')));
    const requestId = req.id;
    log.error?.({ requestId, method: req.method, path: req.path, err: describeError(err) }, 'unhandled error');
    res.status(500).type('application/problem+json').send(problemBody(new AppError(500, 'internal_error', 'An unexpected error occurred.', requestId ? { requestId } : undefined)));
  };
}
