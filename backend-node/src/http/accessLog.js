import { performance } from 'node:perf_hooks';

// One log line per finished request: request ID, method, route pattern, status and duration.
// The route PATTERN is logged (for example `/api/orders/:id`), never the real address, because addresses can hold
// tokens (calendar links, portal links) and the query string can hold anything. Requests that matched no route show `(no route)`.
// Health checks are left out: the host calls them every few seconds and they would bury everything else.
const QUIET = new Set(['/health', '/health/live', '/health/ready']);

export const routePattern = (req) => (typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : '(no route)');

export function accessLogMiddleware(log = console, clock = () => performance.now()) {
  return (req, res, next) => {
    const started = clock();
    res.on('finish', () => {
      const route = routePattern(req);
      if (QUIET.has(route)) return;
      const status = res.statusCode;
      const entry = {
        level: status >= 500 ? 'error' : 'info',
        event: 'request',
        requestId: req.id,
        method: req.method,
        route,
        status,
        durationMs: Math.round((clock() - started) * 10) / 10,
        ...(req.currentUser?.businessId && { businessId: req.currentUser.businessId }),
      };
      (status >= 500 ? log.error : log.info)?.call(log, JSON.stringify(entry));
    });
    next();
  };
}
