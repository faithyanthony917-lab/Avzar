import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import { issueAccessToken } from '../src/security/jwt.js';
import {
  FrameError, attachRealtimeHub, broadcastBusinessEvent, closeRealtimeConnections, createFrameParser,
  encodeFrame, handleNegotiate, publishTaskUpdated, NEGOTIATE_PATH,
} from '../src/realtime/events.js';

const RS = '\x1e';
const env = {
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api',
  JWT_AUDIENCE: 'avzar-mobile',
  ACCESS_TOKEN_MINUTES: 30,
};
const BUSINESS_A = '00000000-0000-4000-8000-0000000000a1';
const BUSINESS_B = '00000000-0000-4000-8000-0000000000b2';
const TASK_ID = '11111111-1111-4111-8111-111111111111';

const pool = {
  query: async (sql, values) => {
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    return { rows: [{ UserId: values[0], BusinessId: values[1], IsOwner: false, Permissions: ['tasks.work'] }] };
  },
};

function tokenFor(businessId) {
  const identity = { userId: '00000000-0000-4000-8000-000000000001', businessId, sessionId: '00000000-0000-4000-8000-000000000003' };
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, identity).token;
}

async function startServer(timing) {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.split('?')[0] === NEGOTIATE_PATH) {
      void handleNegotiate(req, res, env, pool);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  attachRealtimeHub(server, { env, pool, timing });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** Small SignalR-style client built on the platform WebSocket (a real RFC 6455 client: masks frames, decodes any length). */
function openClient(port, token, { query = 'access_token' } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/hubs/business-events?id=abc&${query}=${encodeURIComponent(token)}`);
  const inbox = [];
  const waiters = [];
  const closed = new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  socket.addEventListener('message', (event) => {
    const records = String(event.data).split(RS).filter((part) => part.length);
    for (const record of records) {
      const waiter = waiters.shift();
      if (waiter) waiter(record); else inbox.push(record);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('socket error')), { once: true });
  });
  const next = (ms = 2000) => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    const timer = setTimeout(() => reject(new Error('timed out waiting for a record')), ms);
    waiters.push((record) => { clearTimeout(timer); resolve(record); });
    return undefined;
  });
  const handshake = async () => {
    socket.send(`{"protocol":"json","version":1}${RS}`);
    return next();
  };
  return { socket, opened, next, handshake, closed, inbox };
}

function decodeServerFrame(buffer) {
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  return { opcode: buffer[0] & 0x0f, fin: Boolean(buffer[0] & 0x80), masked: Boolean(buffer[1] & 0x80), payload: buffer.subarray(offset, offset + length), total: offset + length };
}

function maskedClientFrame(opcode, payload, { fin = true, mask = Buffer.from([1, 2, 3, 4]) } = {}) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length])
    : length <= 0xffff ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, length >> 8, length & 0xff])
      : null;
  const body = Buffer.from(payload).map((byte, index) => byte ^ mask[index & 3]);
  return Buffer.concat([head, mask, body]);
}

describe('WebSocket framing', () => {
  it('encodes server frames with the correct length header for every size class', () => {
    for (const size of [0, 1, 125, 126, 127, 230, 65_535, 65_536, 200_000]) {
      const payload = Buffer.alloc(size, 0x61);
      const encoded = encodeFrame(0x1, payload);
      const decoded = decodeServerFrame(encoded);
      assert.equal(decoded.opcode, 1, `opcode for ${size}`);
      assert.equal(decoded.fin, true);
      assert.equal(decoded.masked, false);
      assert.equal(decoded.payload.length, size, `payload length for ${size}`);
      assert.equal(decoded.total, encoded.length, `no truncated or extra bytes for ${size}`);
      assert.ok(decoded.payload.equals(payload));
    }
  });

  it('parses masked client frames split across arbitrary TCP chunks', () => {
    const parser = createFrameParser();
    const payload = Buffer.from(`{"protocol":"json","version":1}${RS}`);
    const frame = maskedClientFrame(0x1, payload);
    const frames = [];
    for (let i = 0; i < frame.length; i += 3) frames.push(...parser.push(frame.subarray(i, i + 3)));
    assert.equal(frames.length, 1);
    assert.ok(frames[0].payload.equals(payload));
    // two frames in one chunk
    const both = parser.push(Buffer.concat([frame, maskedClientFrame(0x9, Buffer.from('hi'))]));
    assert.deepEqual(both.map((f) => f.opcode), [1, 9]);
  });

  it('rejects unmasked, oversized and malformed control frames', () => {
    assert.throws(() => createFrameParser().push(Buffer.from([0x81, 0x01, 0x61])), (error) => error instanceof FrameError && error.closeCode === 1002);
    const huge = Buffer.alloc(10);
    huge[0] = 0x81; huge[1] = 0x80 | 127; huge.writeBigUInt64BE(1n << 40n, 2);
    assert.throws(() => createFrameParser().push(huge), (error) => error instanceof FrameError && error.closeCode === 1009);
    assert.throws(() => createFrameParser().push(maskedClientFrame(0x9, Buffer.from('x'), { fin: false })), FrameError);
  });
});

describe('SignalR negotiate', () => {
  let ctx;
  before(async () => { ctx = await startServer(); });
  after(async () => { ctx.server.closeAllConnections(); await new Promise((resolve) => ctx.server.close(resolve)); });

  it('accepts POST with a bearer token and returns a v1 negotiate response offering WebSockets', async () => {
    const response = await fetch(`http://127.0.0.1:${ctx.port}${NEGOTIATE_PATH}?negotiateVersion=1`, {
      method: 'POST', headers: { authorization: `Bearer ${tokenFor(BUSINESS_A)}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.negotiateVersion, 1);
    assert.ok(body.connectionId && body.connectionToken);
    assert.notEqual(body.connectionId, body.connectionToken);
    assert.deepEqual(body.availableTransports, [{ transport: 'WebSockets', transferFormats: ['Text'] }]);
  });

  it('omits the connection token for negotiate version 0', async () => {
    const response = await fetch(`http://127.0.0.1:${ctx.port}${NEGOTIATE_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${tokenFor(BUSINESS_A)}` },
    });
    const body = await response.json();
    assert.ok(body.connectionId);
    assert.equal(body.connectionToken, undefined);
  });

  it('rejects unauthenticated and invalid-token negotiation with 401', async () => {
    const anonymous = await fetch(`http://127.0.0.1:${ctx.port}${NEGOTIATE_PATH}?negotiateVersion=1`, { method: 'POST' });
    assert.equal(anonymous.status, 401);
    const bad = await fetch(`http://127.0.0.1:${ctx.port}${NEGOTIATE_PATH}?negotiateVersion=1`, {
      method: 'POST', headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(bad.status, 401);
  });
});

describe('SignalR hub over WebSocket', () => {
  let ctx;
  const clients = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) { try { client.socket.close(); } catch { /* already closed */ } }
    closeRealtimeConnections();
    if (ctx) {
      ctx.server.closeAllConnections();
      await new Promise((resolve) => ctx.server.close(resolve));
      ctx = null;
    }
  });
  const connect = async (businessId, options) => {
    const client = openClient(ctx.port, tokenFor(businessId), options);
    clients.push(client);
    await client.opened;
    return client;
  };

  it('answers the JSON handshake with an empty object terminated by the record separator', async () => {
    ctx = await startServer();
    const client = await connect(BUSINESS_A);
    client.socket.send(`{"protocol":"json","version":1}${RS}`);
    const raw = await new Promise((resolve) => client.socket.addEventListener('message', (event) => resolve(event.data), { once: true }));
    assert.equal(raw, `{}${RS}`);
  });

  it('delivers task.updated as a type-1 invocation record only after the handshake', async () => {
    ctx = await startServer();
    const client = await connect(BUSINESS_A);
    broadcastBusinessEvent(BUSINESS_A, 'task.updated', { taskId: 'before-handshake' });
    assert.equal(await client.handshake(), '{}');
    assert.equal(client.inbox.length, 0, 'an event published before the handshake must not reach the client');
    broadcastBusinessEvent(BUSINESS_A, 'task.updated', { taskId: TASK_ID });
    const message = JSON.parse(await client.next());
    assert.deepEqual(message, { type: 1, target: 'task.updated', arguments: [{ taskId: TASK_ID }] });
  });

  it('delivers large events intact (126+ bytes and 64 KB+ frames)', async () => {
    ctx = await startServer();
    const client = await connect(BUSINESS_A);
    await client.handshake();
    for (const size of [100, 126, 230, 70_000, 200_000]) {
      const note = 'x'.repeat(size);
      broadcastBusinessEvent(BUSINESS_A, 'task.updated', { taskId: TASK_ID, note });
      const message = JSON.parse(await client.next(5000));
      assert.equal(message.arguments[0].note.length, size, `payload of ${size} chars survived`);
    }
  });

  it('keeps events inside the business the token belongs to', async () => {
    ctx = await startServer();
    const a = await connect(BUSINESS_A);
    const b = await connect(BUSINESS_B);
    await a.handshake();
    await b.handshake();
    broadcastBusinessEvent(BUSINESS_B, 'task.updated', { taskId: TASK_ID });
    assert.equal(JSON.parse(await b.next()).target, 'task.updated');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(a.inbox.length, 0);
  });

  it('publishTaskUpdated sends the same fields as the C# hub', async () => {
    ctx = await startServer();
    const client = await connect(BUSINESS_A);
    await client.handshake();
    publishTaskUpdated(BUSINESS_A, { task: { id: TASK_ID, status: 'InProgress', assigneeMembershipId: 'm-1', deadlineUtc: '2026-10-20T10:00:00Z', title: 'ignored' } });
    const message = JSON.parse(await client.next());
    assert.deepEqual(message.arguments[0], { taskId: TASK_ID, status: 'InProgress', assigneeMembershipId: 'm-1', deadlineUtc: '2026-10-20T10:00:00Z' });
  });

  it('sends keepalive pings after the handshake', async () => {
    ctx = await startServer({ keepAliveMs: 30 });
    const client = await connect(BUSINESS_A);
    await client.handshake();
    assert.deepEqual(JSON.parse(await client.next()), { type: 6 });
    assert.deepEqual(JSON.parse(await client.next()), { type: 6 });
  });

  it('tolerates client pings and answers invocations that expect a result', async () => {
    ctx = await startServer();
    const client = await connect(BUSINESS_A);
    await client.handshake();
    client.socket.send(`{"type":6}${RS}`);
    client.socket.send(`{"type":1,"invocationId":"7","target":"Nope","arguments":[]}${RS}`);
    const reply = JSON.parse(await client.next());
    assert.equal(reply.type, 3);
    assert.equal(reply.invocationId, '7');
    assert.ok(reply.error);
  });

  it('handles several records and a record split across WebSocket messages', async () => {
    ctx = await startServer();
    const client = await connect(BUSINESS_A);
    client.socket.send('{"protocol":"json",');
    client.socket.send(`"version":1}${RS}{"type":6}${RS}`);
    assert.equal(await client.next(), '{}');
    broadcastBusinessEvent(BUSINESS_A, 'task.updated', { taskId: TASK_ID });
    assert.equal(JSON.parse(await client.next()).target, 'task.updated');
  });

  it('rejects an unsupported protocol with a handshake error and closes', async () => {
    ctx = await startServer();
    const client = await connect(BUSINESS_A);
    client.socket.send(`{"protocol":"messagepack","version":1}${RS}`);
    const reply = JSON.parse(await client.next());
    assert.match(reply.error, /messagepack/);
    await client.closed;
  });

  it('closes a connection that never sends the handshake', async () => {
    ctx = await startServer({ handshakeTimeoutMs: 60 });
    const client = await connect(BUSINESS_A);
    assert.ok(await client.closed);
  });

  it('closes a silent client after the client timeout', async () => {
    ctx = await startServer({ clientTimeoutMs: 80 });
    const client = await connect(BUSINESS_A);
    await client.handshake();
    assert.ok(await client.closed);
  });

  it('refuses the upgrade without a valid token and for other paths', async () => {
    ctx = await startServer();
    const noToken = new WebSocket(`ws://127.0.0.1:${ctx.port}/hubs/business-events`);
    await new Promise((resolve) => { noToken.addEventListener('error', resolve, { once: true }); noToken.addEventListener('close', resolve, { once: true }); });
    assert.notEqual(noToken.readyState, WebSocket.OPEN);
    const badToken = new WebSocket(`ws://127.0.0.1:${ctx.port}/hubs/business-events?access_token=nope`);
    await new Promise((resolve) => { badToken.addEventListener('error', resolve, { once: true }); badToken.addEventListener('close', resolve, { once: true }); });
    assert.notEqual(badToken.readyState, WebSocket.OPEN);
  });
});
