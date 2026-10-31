import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { accessLogMiddleware, routePattern } from '../../src/http/accessLog.js';
import { describeErrorShape } from '../../src/http/errors.js';

function run({ route, baseUrl = '', status = 200, method = 'GET', currentUser, originalUrl = '/x' }, log, clock) {
  const res = new EventEmitter();
  res.statusCode = status;
  const req = { id: 'req-12345678', method, baseUrl, originalUrl, ...(route && { route: { path: route } }), ...(currentUser && { currentUser }) };
  let nexted = false;
  accessLogMiddleware(log, clock)(req, res, () => { nexted = true; });
  res.emit('finish');
  return { nexted };
}
const recorder = () => { const lines = []; return { lines, info: (line) => lines.push(['info', JSON.parse(line)]), error: (line) => lines.push(['error', JSON.parse(line)]) }; };

describe('access log', () => {
  it('logs the route pattern, not the real address or the query string', () => {
    const log = recorder();
    const { nexted } = run({ route: '/calendar/:token', baseUrl: '/api', originalUrl: '/api/calendar/SECRETTOKEN?x=1' }, log);
    assert.equal(nexted, true);
    assert.equal(log.lines.length, 1);
    const [level, entry] = log.lines[0];
    assert.equal(level, 'info');
    assert.equal(entry.route, '/api/calendar/:token');
    assert.equal(entry.requestId, 'req-12345678');
    assert.equal(entry.status, 200);
    assert.equal(JSON.stringify(entry).includes('SECRETTOKEN'), false);
    assert.equal(JSON.stringify(entry).includes('x=1'), false);
  });
  it('shows (no route) for an unmatched request and uses the error level for a 5xx', () => {
    const log = recorder();
    run({ status: 404, originalUrl: '/api/guess/ABC' }, log);
    run({ route: '/orders', baseUrl: '/api', status: 500 }, log);
    assert.equal(log.lines[0][1].route, '(no route)');
    assert.equal(JSON.stringify(log.lines[0]).includes('ABC'), false);
    assert.equal(log.lines[1][0], 'error');
    assert.equal(log.lines[1][1].status, 500);
  });
  it('skips health checks, adds the business when signed in, and measures the duration', () => {
    const log = recorder();
    run({ route: '/health/live' }, log);
    run({ route: '/health/ready' }, log);
    run({ route: '/health' }, log);
    assert.equal(log.lines.length, 0);
    let t = 100;
    run({ route: '/orders', baseUrl: '/api', currentUser: { businessId: 'biz-1', userId: 'user-1' } }, log, () => (t += 12.34));
    const entry = log.lines[0][1];
    assert.equal(entry.businessId, 'biz-1');
    assert.equal(entry.durationMs, 12.3);
    assert.equal(JSON.stringify(entry).includes('user-1'), false);
  });
  it('does not break when the logger has no matching method', () => {
    assert.doesNotThrow(() => run({ route: '/orders', baseUrl: '/api' }, {}));
  });
  it('builds the pattern only from a string route path', () => {
    assert.equal(routePattern({ baseUrl: '/api', route: { path: /x/ } }), '(no route)');
    assert.equal(routePattern({}), '(no route)');
  });
});

describe('worker error shape', () => {
  it('keeps type, code, status and causes, never a message or a stack', () => {
    const inner = Object.assign(new Error('secret value 42'), { name: 'S3ServiceException', $metadata: { httpStatusCode: 403 } });
    const outer = Object.assign(new Error('wrapped secret'), { code: 'ECONNRESET', cause: inner });
    const shape = describeErrorShape(outer);
    assert.equal(shape.code, 'ECONNRESET');
    assert.equal(shape.cause.name, 'S3ServiceException');
    assert.equal(shape.cause.httpStatus, 403);
    assert.equal(JSON.stringify(shape).includes('secret'), false);
    assert.equal(JSON.stringify(shape).includes('stack'), false);
    assert.deepEqual(describeErrorShape('text'), { name: 'string' });
  });
});
