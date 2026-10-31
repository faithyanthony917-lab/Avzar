import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { listDesigns } from '../src/auth/designService.js';
import { listCollections } from '../src/auth/collectionService.js';
import { listInquiries, updateInquiry } from '../src/auth/inquiryService.js';
import { listMedia, uploadMedia } from '../src/auth/mediaService.js';
import { listDocuments } from '../src/auth/documentService.js';

// Step 4c: enum-like strings are read the way C# Parse.Value reads them (trimmed, case-insensitive, canonical spelling stored),
// and a blank query filter is ignored. Each service test passes a recording pool and checks the values sent to PostgreSQL.

const env = {
  NODE_ENV: 'test',
  PORT: 8081,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api',
  JWT_AUDIENCE: 'avzar-mobile',
  ACCESS_TOKEN_MINUTES: 10,
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function bearerToken(userId = '00000000-0000-4000-8000-000000000001', businessId = '00000000-0000-4000-8000-000000000002', sessionId = '00000000-0000-4000-8000-000000000003') {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId }).token;
}

const tenantOwner = {
  UserId: '00000000-0000-4000-8000-000000000001',
  BusinessId: '00000000-0000-4000-8000-000000000002',
  Email: 'owner@example.test',
  FullName: 'Owner',
  BusinessName: 'Shop',
  TimeZoneId: 'UTC',
  CurrencyCode: 'USD',
  IsOwner: true,
  Permissions: [],
};

function authenticatedPool(domainQuery) {
  async function query(sql, values) {
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [tenantOwner] };
    return domainQuery(sql, values);
  }
  return { query, async connect() { return { query, release() {} }; } };
}


const BUSINESS = '00000000-0000-4000-8000-000000000002';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const user = { businessId: BUSINESS, userId: '00000000-0000-4000-8000-000000000001' };

function recordingPool() {
  const calls = [];
  return { calls, pool: { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } } };
}
const countValues = (calls) => calls[0].values;
const rejects = (promise, code) => assert.rejects(promise, (error) => error.status === 400 && error.code === code);

const authHeaders = () => ({ authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' });

describe('list filters read enums like C# Parse.Value', () => {
  it('designs: status, kind and visibility are trimmed and case-insensitive; blank filters are ignored', async () => {
    const { pool, calls } = recordingPool();
    await listDesigns(pool, BUSINESS, { status: ' archived ', kind: 'readymade', visibility: 'PUBLIC' });
    assert.deepEqual(countValues(calls), [BUSINESS, 'Archived', 'ReadyMade', 'Public']);

    const blank = recordingPool();
    await listDesigns(blank.pool, BUSINESS, { status: ' ', kind: '  ', visibility: '' });
    assert.deepEqual(countValues(blank.calls), [BUSINESS, 'Active']);

    await rejects(listDesigns(recordingPool().pool, BUSINESS, { kind: 'dress' }), 'invalid_kind');
    await rejects(listDesigns(recordingPool().pool, BUSINESS, { status: 'deleted' }), 'invalid_status');
    await rejects(listDesigns(recordingPool().pool, BUSINESS, { visibility: 'hidden' }), 'invalid_visibility');
  });

  it('collections: visibility is trimmed and case-insensitive; blank is ignored', async () => {
    const { pool, calls } = recordingPool();
    await listCollections(pool, BUSINESS, { visibility: ' public ' });
    assert.deepEqual(countValues(calls), [BUSINESS, 'Public']);

    const blank = recordingPool();
    await listCollections(blank.pool, BUSINESS, { visibility: ' ' });
    assert.deepEqual(countValues(blank.calls), [BUSINESS]);

    await rejects(listCollections(recordingPool().pool, BUSINESS, { visibility: 'secret' }), 'invalid_visibility');
  });

  it('inquiries: status and kind filters, and the staff status update, are case-insensitive', async () => {
    const { pool, calls } = recordingPool();
    await listInquiries(pool, user, { status: 'REVIEWED', kind: ' quotation' });
    assert.deepEqual(countValues(calls), [BUSINESS, 'Reviewed', 'Quotation']);

    await rejects(listInquiries(recordingPool().pool, user, { status: 'open' }), 'invalid_status');
    await rejects(listInquiries(recordingPool().pool, user, { kind: 'complaint' }), 'invalid_kind');

    await rejects(updateInquiry(recordingPool().pool, user, CUSTOMER, { status: ' CONVERTED ' }), 'use_convert');
    await rejects(updateInquiry(recordingPool().pool, user, CUSTOMER, { status: 'closed' }), 'invalid_status');
  });

  it('media: the purpose filter and the upload purpose are case-insensitive', async () => {
    const { pool, calls } = recordingPool();
    await listMedia(pool, user, { purpose: ' siteimage' });
    assert.deepEqual(countValues(calls), [BUSINESS, 'SiteImage']);

    await rejects(listMedia(recordingPool().pool, user, { purpose: 'banner' }), 'invalid_purpose');
    await rejects(uploadMedia(recordingPool().pool, { MEDIA_MAX_UPLOAD_BYTES: 1000 }, null, user, Buffer.from('x'), 'a.png', 'Banner'), 'invalid_purpose');
  });

  it('documents: the kind filter is case-insensitive', async () => {
    const { pool, calls } = recordingPool();
    await listDocuments(pool, user, { kind: 'PDF' });
    assert.deepEqual(countValues(calls), [BUSINESS, 'Pdf']);

    await rejects(listDocuments(recordingPool().pool, user, { kind: 'image' }), 'invalid_kind');
  });
});

describe('customer, order and task routes read enums like C# Parse.Value', () => {
  it('customer list: status filter is case-insensitive; a blank status is ignored; unknown is invalid_status', async () => {
    const seen = [];
    const pool = authenticatedPool(async (sql, values) => {
      if (sql.includes('count(*)::int AS "TotalCount"')) { seen.push(values); return { rows: [{ TotalCount: 0 }] }; }
      return { rows: [] };
    });
    const app = createApp(env, pool);

    const inactive = await requestApp(app, '/api/customers?status=%20INACTIVE%20', { headers: authHeaders() });
    assert.equal(inactive.status, 200);
    assert.deepEqual(seen[0], [BUSINESS, 'Inactive']);

    const blank = await requestApp(app, '/api/customers?status=%20', { headers: authHeaders() });
    assert.equal(blank.status, 200);
    assert.deepEqual(seen[1], [BUSINESS]);

    const bad = await requestApp(app, '/api/customers?status=archived', { headers: authHeaders() });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_status');
  });

  it('customer status change: " inactive " is accepted; Merged is rejected with invalid_status like C#', async () => {
    const updates = [];
    const pool = authenticatedPool(async (sql, values) => {
      if (sql.includes('SELECT "Status" FROM "Customers"')) return { rows: [{ Status: 'Active' }] };
      if (sql.includes('UPDATE "Customers" SET "Status"')) {
        updates.push(values[0]);
        return { rows: [{ Id: CUSTOMER, FullName: 'Nia Adebayo', Email: null, Phone: null, AddressLine: null, City: null, Notes: null,
          GarmentPreferences: null, Status: values[0], MergedIntoCustomerId: null, Version: 2, CreatedAtUtc: new Date('2025-01-01T00:00:00.000Z') }] };
      }
      return { rows: [] };
    });
    const app = createApp(env, pool);

    const ok = await requestApp(app, `/api/customers/${CUSTOMER}/status`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ status: ' inactive ' }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(updates, ['Inactive']);
    assert.equal(ok.body.status, 'Inactive');

    const merged = await requestApp(app, `/api/customers/${CUSTOMER}/status`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ status: 'merged' }) });
    assert.equal(merged.status, 400);
    assert.equal(merged.body.code, 'invalid_status');

    const unknown = await requestApp(app, `/api/customers/${CUSTOMER}/status`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ status: 'Deleted' }) });
    assert.equal(unknown.status, 400);
    assert.equal(updates.length, 1);
  });

  it('communications: channel and direction are stored with the canonical spelling', async () => {
    const inserts = [];
    const pool = authenticatedPool(async (sql, values) => {
      if (sql.includes('SELECT 1 FROM "Customers"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO "CustomerCommunications"')) {
        inserts.push([values[3], values[4]]);
        return { rows: [{ Id: values[0], Channel: values[3], Direction: values[4], Subject: null, Body: values[6], RecordedByUserId: values[7], CreatedAtUtc: new Date('2025-01-01T00:00:00.000Z') }] };
      }
      return { rows: [] };
    });
    const app = createApp(env, pool);

    const created = await requestApp(app, `/api/customers/${CUSTOMER}/communications`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ channel: ' whatsapp ', direction: 'INBOUND', body: 'Asked about delivery' }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(inserts, [['WhatsApp', 'Inbound']]);
    assert.equal(created.body.channel, 'WhatsApp');

    const bad = await requestApp(app, `/api/customers/${CUSTOMER}/communications`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ channel: 'Pigeon', direction: 'Inbound', body: 'x' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(inserts.length, 1);
  });

  it('order list and task list: status and priority filters are case-insensitive; unknown values are invalid_<field>', async () => {
    const seen = [];
    const pool = authenticatedPool(async (sql, values) => {
      if (sql.includes('count(*)::int AS "TotalCount"')) { seen.push({ from: sql.includes('FROM "Orders" o') && !sql.includes('ProductionTasks') ? 'orders' : 'tasks', values }); return { rows: [{ TotalCount: 0 }] }; }
      return { rows: [] };
    });
    const app = createApp(env, pool);

    const orders = await requestApp(app, '/api/orders?status=%20inproduction', { headers: authHeaders() });
    assert.equal(orders.status, 200);
    assert.equal(seen[0].from, 'orders');
    assert.equal(seen[0].values.at(-1), 'InProduction');

    const tasks = await requestApp(app, '/api/tasks?status=in-progress&priority=x', { headers: authHeaders() });
    assert.equal(tasks.status, 400);

    const tasksOk = await requestApp(app, '/api/tasks?status=INPROGRESS&priority=%20urgent', { headers: authHeaders() });
    assert.equal(tasksOk.status, 200);
    assert.deepEqual(seen[1].values.slice(2), ['InProgress', 'Urgent']);

    const badOrder = await requestApp(app, '/api/orders?status=shipped', { headers: authHeaders() });
    assert.equal(badOrder.status, 400);
    assert.equal(badOrder.body.code, 'invalid_status');
    const badTask = await requestApp(app, '/api/tasks?priority=critical', { headers: authHeaders() });
    assert.equal(badTask.status, 400);
    assert.equal(badTask.body.code, 'invalid_priority');
  });
});
