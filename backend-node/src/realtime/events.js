import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { currentUser } from '../auth/mobileAuthService.js';
import { verifyAccessToken } from '../security/jwt.js';
import { runWithTenantRlsContext } from '../db/tenantRlsContext.js';
import { useBusiness } from '../db/userScope.js';

// Minimal server side of the SignalR JSON hub protocol over WebSockets, enough for @microsoft/signalr clients
// (mobile/avzar-expo). It is authenticated, tenant scoped,
// server-to-client events only. Clients never choose a group; the business comes from the verified token.
//
// Connections live in this process's memory. Running more than one replica needs a shared fan-out (e.g. Redis).

export const HUB_PATH = '/hubs/business-events';
export const NEGOTIATE_PATH = `${HUB_PATH}/negotiate`;

const RECORD_SEPARATOR = '\x1e';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CLIENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;

// SignalR message types.
const INVOCATION = 1;
const COMPLETION = 3;
const STREAM_INVOCATION = 4;
const PING = 6;
const CLOSE = 7;

const DEFAULT_TIMING = Object.freeze({
  keepAliveMs: 15_000,
  clientTimeoutMs: 30_000,
  handshakeTimeoutMs: 15_000,
});

const businessConnections = new Map();

// ---------------------------------------------------------------- authentication

function getTokenFromRequest(req) {
  const query = new URL(req.url, 'http://localhost');
  const direct = query.searchParams.get('access_token');
  if (direct) return direct;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

async function resolveRealtimeUser(req, env, pool) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const identity = verifyAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, token);
  if (!identity || !pool) return null;
  // The hub does not go through requireBearerAuth, so it binds the signed token's business itself, in a context of its own.
  return runWithTenantRlsContext(async () => {
    useBusiness(pool, identity.businessId);
    const { rows } = await pool.query(`
      SELECT 1 FROM "UserSessions" WHERE "Id" = $1 AND "UserId" = $2 AND "RevokedAtUtc" IS NULL AND "AbsoluteExpiresAtUtc" > now() AND "IdleExpiresAtUtc" > now()`,
    [identity.sessionId, identity.userId]);
    if (!rows.length) return null;
    const user = await currentUser(pool, identity.userId, identity.businessId);
    if (!user) return null;
    return { identity, user };
  });
}

// ---------------------------------------------------------------- connection registry

function addConnection(businessId, connection) {
  const bucket = businessConnections.get(businessId) ?? new Set();
  bucket.add(connection);
  businessConnections.set(businessId, bucket);
}

function removeConnection(businessId, connection) {
  const bucket = businessConnections.get(businessId);
  if (!bucket) return;
  bucket.delete(connection);
  if (!bucket.size) businessConnections.delete(businessId);
}

// ---------------------------------------------------------------- RFC 6455 framing

/** Encodes one unmasked server-to-client frame (FIN set). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

export class FrameError extends Error {
  constructor(closeCode, message) {
    super(message);
    this.closeCode = closeCode;
  }
}

/**
 * Incremental parser for client-to-server frames. push() accepts arbitrary TCP chunks and returns the complete
 * frames received so far: { fin, opcode, payload }. Throws FrameError for protocol violations.
 */
export function createFrameParser({ maxPayload = MAX_CLIENT_PAYLOAD_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const frames = [];
      for (;;) {
        if (buffer.length < 2) break;
        const first = buffer[0];
        const second = buffer[1];
        if (first & 0x70) throw new FrameError(1002, 'Reserved bits must be zero.');
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        if (!(second & 0x80)) throw new FrameError(1002, 'Client frames must be masked.');
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) break;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) break;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(maxPayload)) throw new FrameError(1009, 'Frame is too large.');
          length = Number(big);
          offset = 10;
        }
        if (opcode >= 0x08 && (!fin || length > 125)) throw new FrameError(1002, 'Invalid control frame.');
        if (length > maxPayload) throw new FrameError(1009, 'Frame is too large.');
        if (buffer.length < offset + 4 + length) break;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
        frames.push({ fin, opcode, payload });
        buffer = buffer.subarray(offset + 4 + length);
      }
      return frames;
    },
  };
}

function acceptKey(clientKey) {
  return createHash('sha1').update(`${clientKey}${WS_GUID}`).digest('base64');
}

// ---------------------------------------------------------------- sending

function writeFrame(connection, opcode, payload) {
  const { socket } = connection;
  if (!socket || socket.destroyed || socket.writableEnded) return false;
  if (socket.writableLength > MAX_QUEUED_BYTES) {
    socket.destroy(); // a client that cannot keep up must not make the server buffer without bound
    return false;
  }
  socket.write(encodeFrame(opcode, payload));
  return true;
}

function sendRecord(connection, message) {
  return writeFrame(connection, 0x1, Buffer.from(`${JSON.stringify(message)}${RECORD_SEPARATOR}`, 'utf8'));
}

function sendRawRecord(connection, text) {
  return writeFrame(connection, 0x1, Buffer.from(`${text}${RECORD_SEPARATOR}`, 'utf8'));
}

function closeConnection(connection, code = 1000) {
  const { socket } = connection;
  if (!socket || socket.destroyed) return;
  if (!socket.writableEnded) {
    const reason = Buffer.alloc(2);
    reason.writeUInt16BE(code, 0);
    socket.write(encodeFrame(0x8, reason));
  }
  socket.end();
  socket.destroy();
}

export function broadcastBusinessEvent(businessId, eventName, payload) {
  const bucket = businessConnections.get(businessId);
  if (!bucket) return;
  const frame = encodeFrame(0x1, Buffer.from(
    `${JSON.stringify({ type: INVOCATION, target: eventName, arguments: [payload] })}${RECORD_SEPARATOR}`, 'utf8'));
  for (const connection of [...bucket]) {
    const { socket } = connection;
    if (!socket || socket.destroyed || socket.writableEnded) continue;
    if (socket.writableLength > MAX_QUEUED_BYTES) {
      socket.destroy();
      continue;
    }
    socket.write(frame);
  }
}

/** Payload the worker-task endpoints publish. `detail` is the result of loadTaskDetail(). */
export function publishTaskUpdated(businessId, detail) {
  const task = detail?.task;
  if (!task) return;
  broadcastBusinessEvent(businessId, 'task.updated', {
    taskId: task.id,
    status: task.status,
    assigneeMembershipId: task.assigneeMembershipId ?? null,
    deadlineUtc: task.deadlineUtc ?? null,
  });
}

/** Closes every open realtime socket; used on shutdown so server.close() can finish. */
export function closeRealtimeConnections() {
  for (const bucket of businessConnections.values()) {
    for (const connection of [...bucket]) closeConnection(connection, 1001);
  }
  businessConnections.clear();
}

// ---------------------------------------------------------------- negotiate

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** POST /hubs/business-events/negotiate. Plain Node req/res so it works under Express and in a bare http server. */
export async function handleNegotiate(req, res, env, pool) {
  try {
    const user = await resolveRealtimeUser(req, env, pool);
    if (!user) {
      sendJson(res, 401, { code: 'unauthorized', message: 'Authentication is required.' });
      return;
    }
    const query = new URL(req.url, 'http://localhost').searchParams;
    const version = Number(query.get('negotiateVersion') ?? 0);
    const connectionId = randomUUID();
    const availableTransports = [{ transport: 'WebSockets', transferFormats: ['Text'] }];
    if (version >= 1) {
      sendJson(res, 200, {
        negotiateVersion: 1, connectionId, connectionToken: randomBytes(18).toString('base64url'), availableTransports,
      });
    } else {
      sendJson(res, 200, { connectionId, availableTransports });
    }
  } catch {
    sendJson(res, 500, { code: 'server_error', message: 'The realtime service could not complete the request.' });
  }
}

// ---------------------------------------------------------------- hub protocol

function handleHandshakeRecord(connection, record) {
  let request;
  try {
    request = JSON.parse(record);
  } catch {
    sendRawRecord(connection, JSON.stringify({ error: 'Error parsing handshake request.' }));
    return false;
  }
  if (request?.protocol !== 'json') {
    sendRawRecord(connection, JSON.stringify({ error: `The protocol '${request?.protocol ?? ''}' is not supported.` }));
    return false;
  }
  if (request.version !== 1) {
    sendRawRecord(connection, JSON.stringify({ error: `Requested protocol version '${request.version ?? ''}' is not supported.` }));
    return false;
  }
  sendRawRecord(connection, '{}');
  return true;
}

function handleHubRecord(connection, record) {
  let message;
  try {
    message = JSON.parse(record);
  } catch {
    sendRecord(connection, { type: CLOSE, error: 'Invalid message.' });
    return false;
  }
  switch (message?.type) {
    case PING:
      return true;
    case CLOSE:
      return false;
    case INVOCATION:
    case STREAM_INVOCATION:
      // The hub exposes no client-callable methods. Answer calls that expect a result so clients do not wait forever.
      if (message.invocationId) {
        sendRecord(connection, {
          type: COMPLETION, invocationId: message.invocationId, error: 'Method does not exist.',
        });
      }
      return true;
    default:
      return true;
  }
}

function startConnection(connection, user, timing, head) {
  const { socket } = connection;
  const parser = createFrameParser();
  let handshaken = false;
  let text = '';
  let fragments = null;
  let lastReceivedAt = Date.now();
  let keepAliveTimer = null;
  let timeoutTimer = null;
  let handshakeTimer = null;

  const cleanup = () => {
    clearInterval(keepAliveTimer);
    clearInterval(timeoutTimer);
    clearTimeout(handshakeTimer);
    removeConnection(connection.businessId, connection);
  };

  const finish = (code = 1000) => {
    cleanup();
    closeConnection(connection, code);
  };

  const onText = (chunk) => {
    text += chunk;
    for (;;) {
      const end = text.indexOf(RECORD_SEPARATOR);
      if (end < 0) break;
      const record = text.slice(0, end);
      text = text.slice(end + 1);
      if (!handshaken) {
        if (!handleHandshakeRecord(connection, record)) {
          finish(1000);
          return false;
        }
        handshaken = true;
        clearTimeout(handshakeTimer);
        addConnection(connection.businessId, connection);
        keepAliveTimer = setInterval(() => sendRecord(connection, { type: PING }), timing.keepAliveMs);
        keepAliveTimer.unref?.();
        timeoutTimer = setInterval(() => {
          if (Date.now() - lastReceivedAt > timing.clientTimeoutMs) finish(1001);
        }, Math.max(1, Math.floor(timing.clientTimeoutMs / 2)));
        timeoutTimer.unref?.();
      } else if (!handleHubRecord(connection, record)) {
        finish(1000);
        return false;
      }
    }
    if (text.length > MAX_CLIENT_PAYLOAD_BYTES) {
      finish(1009);
      return false;
    }
    return true;
  };

  const onFrame = (frame) => {
    switch (frame.opcode) {
      case 0x1:
        if (fragments) throw new FrameError(1002, 'Unexpected new message during fragmentation.');
        if (frame.fin) return onText(frame.payload.toString('utf8'));
        fragments = [frame.payload];
        return true;
      case 0x0: {
        if (!fragments) throw new FrameError(1002, 'Unexpected continuation frame.');
        fragments.push(frame.payload);
        if (fragments.reduce((sum, part) => sum + part.length, 0) > MAX_CLIENT_PAYLOAD_BYTES) {
          throw new FrameError(1009, 'Message is too large.');
        }
        if (!frame.fin) return true;
        const whole = Buffer.concat(fragments);
        fragments = null;
        return onText(whole.toString('utf8'));
      }
      case 0x2:
        throw new FrameError(1003, 'Binary messages are not supported.');
      case 0x8:
        finish(1000);
        return false;
      case 0x9:
        writeFrame(connection, 0xA, frame.payload);
        return true;
      default:
        return true; // pong and unknown control frames
    }
  };

  const onData = (chunk) => {
    lastReceivedAt = Date.now();
    let frames;
    try {
      frames = parser.push(chunk);
      for (const frame of frames) {
        if (!onFrame(frame)) return;
      }
    } catch (error) {
      finish(error instanceof FrameError ? error.closeCode : 1002);
    }
  };

  socket.on('data', onData);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  socket.on('end', () => finish(1000));
  handshakeTimer = setTimeout(() => finish(1002), timing.handshakeTimeoutMs);
  handshakeTimer.unref?.();
  socket.resume();
  if (head?.length) onData(head);
}

function rejectUpgrade(socket, status, body) {
  const text = JSON.stringify(body);
  socket.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  socket.destroy();
}

function acceptWebSocketUpgrade(request, socket, head, env, pool, timing) {
  socket.pause(); // keep any early bytes queued until the data handler exists
  socket.on('error', () => {});
  const path = new URL(request.url, 'http://localhost').pathname;
  const clientKey = request.headers['sec-websocket-key'];
  if (path !== HUB_PATH) {
    rejectUpgrade(socket, '404 Not Found', { code: 'not_found', message: 'Not found.' });
    return;
  }
  if (!clientKey || String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    rejectUpgrade(socket, '400 Bad Request', { code: 'bad_request', message: 'A WebSocket upgrade is required.' });
    return;
  }
  void resolveRealtimeUser(request, env, pool).then((user) => {
    if (!user) {
      rejectUpgrade(socket, '401 Unauthorized', { code: 'unauthorized', message: 'Authentication is required.' });
      return;
    }
    if (socket.destroyed) return;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(clientKey)}\r\n\r\n`);
    socket.setNoDelay(true);
    const connection = { id: randomUUID(), businessId: user.user.businessId, userId: user.identity.userId, socket };
    startConnection(connection, user, timing, head);
  }).catch(() => {
    rejectUpgrade(socket, '401 Unauthorized', { code: 'unauthorized', message: 'Authentication is required.' });
  });
}

export function attachRealtimeHub(target, { env, pool, timing } = {}) {
  if (!target || target.__avzarRealtimeAttached) return target;
  target.__avzarRealtimeAttached = true;
  const effectiveTiming = { ...DEFAULT_TIMING, ...(timing ?? {}) };

  // Express app: the SignalR client negotiates with POST.
  if (typeof target.use === 'function') {
    target.post(NEGOTIATE_PATH, (req, res) => handleNegotiate(req, res, env, pool));
  }

  // http.Server: WebSocket upgrade.
  if (typeof target.listen === 'function') {
    target.on('upgrade', (req, socket, head) => {
      if (!req.url || !req.url.startsWith(HUB_PATH)) return;
      acceptWebSocketUpgrade(req, socket, head, env, pool, effectiveTiming);
    });
  }

  return target;
}

export function registerRealtimeConnectionForTest(businessId, connection) {
  addConnection(businessId, connection);
}

export function getRealtimeConnectionsForTest(businessId) {
  return businessConnections.get(businessId) ?? new Set();
}
