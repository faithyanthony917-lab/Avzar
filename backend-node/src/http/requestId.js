import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const store = new AsyncLocalStorage();
// A caller may supply its own ID (for example a proxy). Only a short, plain value is kept, so it cannot inject into a log line.
const ACCEPTED = /^[A-Za-z0-9._-]{8,64}$/;

/** Gives every request an ID, returns it in the `x-request-id` header and makes it readable anywhere below. */
export function requestIdMiddleware() {
  return (req, res, next) => {
    const supplied = req.headers?.['x-request-id'];
    const id = typeof supplied === 'string' && ACCEPTED.test(supplied) ? supplied : randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);
    store.run({ requestId: id }, next);
  };
}

export const currentRequestId = () => store.getStore()?.requestId;
