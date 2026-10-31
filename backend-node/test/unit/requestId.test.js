import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { currentRequestId, requestIdMiddleware } from '../../src/http/requestId.js';
import { AppError, describeError, errorHandler } from '../../src/http/errors.js';
import { securityHeaders } from '../../src/http/securityHeaders.js';

function fakeRes() {
  const headers = {};
  return { headers, headersSent: false, statusCode: 200, body: undefined,
    setHeader(name, value) { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; } };
}
function run(header) {
  const res = fakeRes();
  const req = { headers: header === undefined ? {} : { 'x-request-id': header } };
  let seen;
  requestIdMiddleware()(req, res, () => { seen = currentRequestId(); });
  return { req, res, seen };
}

describe('request IDs', () => {
  it('makes an ID, returns it in the header and exposes it below the middleware', () => {
    const { req, res, seen } = run();
    assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(req.id, res.headers['x-request-id']);
    assert.equal(seen, req.id);
    assert.equal(currentRequestId(), undefined);
  });
  it('keeps a plain supplied ID and replaces anything unsafe', () => {
    assert.equal(run('abc12345-edge.1').res.headers['x-request-id'], 'abc12345-edge.1');
    for (const bad of ['short', 'has space in it', 'a'.repeat(65), 'line\nbreak12345', '<script>12345</script>']) {
      const id = run(bad).res.headers['x-request-id'];
      assert.notEqual(id, bad);
      assert.match(id, /^[0-9a-f-]{36}$/);
    }
  });
  it('gives two requests two different IDs', () => {
    assert.notEqual(run().req.id, run().req.id);
  });
});

describe('error logging', () => {
  it('logs the request ID, stack and the whole cause chain, and tells the caller the ID', () => {
    const logged = [];
    const log = { error: (...args) => logged.push(args) };
    const cause = Object.assign(new Error('socket hang up'), { name: 'NetworkingError', code: 'ECONNRESET' });
    const err = Object.assign(new Error('S3 failed', { cause }), { name: 'S3ServiceException', $metadata: { httpStatusCode: 403 }, detail: 'Key (email)=(a@b.test)' });
    const res = fakeRes();
    errorHandler(log)(err, { id: 'req-12345678', method: 'GET', path: '/api/x' }, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'internal_error');
    assert.equal(res.body.requestId, 'req-12345678');
    assert.equal(res.body.title, 'An unexpected error occurred.');
    const [fields, message] = logged[0];
    assert.equal(message, 'unhandled error');
    assert.equal(fields.requestId, 'req-12345678');
    assert.equal(fields.err.name, 'S3ServiceException');
    assert.equal(fields.err.httpStatus, 403);
    assert.match(fields.err.stack, /S3 failed/);
    assert.equal(fields.err.cause.code, 'ECONNRESET');
    assert.equal(JSON.stringify(fields).includes('a@b.test'), false);
  });
  it('still renders an AppError as before and leaves the 500 body without an ID when there is none', () => {
    const res = fakeRes();
    errorHandler({})(AppError.badRequest('bad', 'Nope.'), { id: 'x' }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.requestId, undefined);
    const res500 = fakeRes();
    errorHandler({})(new Error('boom'), {}, res500, () => {});
    assert.equal(res500.body.requestId, undefined);
  });
  it('limits how deep a cause chain is described', () => {
    let err = new Error('level 5');
    for (let i = 4; i >= 0; i -= 1) err = new Error(`level ${i}`, { cause: err });
    let depth = 0;
    for (let d = describeError(err); d.cause; d = d.cause) depth += 1;
    assert.equal(depth, 3);
  });
});

describe('security headers', () => {
  const apply = (env) => { const res = fakeRes(); let nexted = false; securityHeaders(env)({}, res, () => { nexted = true; }); return { headers: res.headers, nexted }; };
  it('always sets the existing headers and the opener policy', () => {
    const { headers, nexted } = apply({ NODE_ENV: 'test' });
    assert.equal(nexted, true);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
    assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(headers['strict-transport-security'], undefined);
  });
  it('keeps /api answers out of other sites and out of caches, and leaves other paths alone', () => {
    const at = (url) => { const res = fakeRes(); securityHeaders({ NODE_ENV: 'test' })({ originalUrl: url }, res, () => {}); return res.headers; };
    assert.equal(at('/api/orders?x=1')['cross-origin-resource-policy'], 'same-origin');
    assert.equal(at('/api/orders')['cache-control'], 'no-store');
    assert.equal(at('/sites/shop')['cross-origin-resource-policy'], undefined);
    assert.equal(at('/sites/shop')['cache-control'], undefined);
    assert.equal(at('/media/public/abc')['cross-origin-resource-policy'], undefined);
  });
  it('adds strict transport security only in production, without subdomains', () => {
    assert.equal(apply({ NODE_ENV: 'production' }).headers['strict-transport-security'], 'max-age=15552000');
    assert.equal(apply({ NODE_ENV: 'development' }).headers['strict-transport-security'], undefined);
  });
});
