import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { newCsrfToken } from '../src/security/csrf.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const otherBusinessId = '00000000-0000-4000-8000-000000000022';
const userId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000003';
const locationId = '00000000-0000-4000-8000-000000000060';
const materialId = '00000000-0000-4000-8000-000000000061';
const env = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 8081, LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};
const csv = 'SKU,Name,Unit,Opening stock,Reorder level\nNEW-1,Thread,spool,2.125,0.500';

function bearer(business = businessId) {
  return issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES },
  { userId, businessId: business, sessionId }).token;
}

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* CSV remains plain text. */ }
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function inventoryPool({ owner = true, permissions = ['inventory.view', 'inventory.manage'], allowed = [locationId], activeBusiness = businessId } = {}) {
  const state = { materials: [], movements: [] };
  async function query(sql, values = []) {
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) {
      return values[1] === activeBusiness ? { rows: [{ UserId: userId, Email: 'owner@example.test', FullName: 'Owner', BusinessId: activeBusiness,
        BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: owner, Permissions: permissions }] } : { rows: [] };
    }
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'full' }] };
    if (sql.includes('SELECT DISTINCT ml."LocationId"')) return { rows: allowed.map((LocationId) => ({ LocationId })) };
    if (sql.includes('FROM "Locations"')) return { rows: values.length > 1 ? (values[1] === locationId ? [{ Id: locationId }] : []) : [{ Id: locationId, Name: 'Workshop', Address: null, IsActive: true }] };
    if (sql.includes('FROM "Materials" m')) {
      const rows = state.materials.filter((material) => material.BusinessId === values[0]
        && (!Array.isArray(values[1]) || values[1] === null || values[1].includes(material.LocationId)));
      return { rows: rows.map((material) => ({ ...material, Version: '1' })) };
    }
    if (sql.includes('FROM "Materials" WHERE "BusinessId" = $1 AND "Id" = $2')) {
      const material = state.materials.find((row) => row.BusinessId === values[0] && row.Id === values[1]);
      return { rows: material ? [{ ...material, Version: '1' }] : [] };
    }
    if (sql.includes('FROM "Materials" WHERE "BusinessId" = $1 AND upper')) return { rows: [] };
    if (sql.includes('FROM "Materials" WHERE "BusinessId" = $1')) return { rows: [] };
    if (sql.includes('FROM "StockMovements"')) return { rows: state.movements.slice().reverse() };
    return { rows: [], rowCount: 1 };
  }
  return {
    state,
    query,
    connect: async () => ({
      query: async (sql, values = []) => {
        if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'full' }] };
        if (sql.includes('FROM "Locations"')) return { rows: values[1] === locationId ? [{ Id: locationId }] : [] };
        if (sql.includes('FROM "Materials" WHERE "BusinessId" = $1 AND upper')) return { rows: [] };
        if (sql.includes('FROM "Materials"')) {
          const material = state.materials.find((row) => row.BusinessId === values[0] && row.Id === values[1]);
          return { rows: material ? [{ ...material, Version: '1' }] : [] };
        }
        if (sql.includes('INSERT INTO "Materials"')) {
          state.materials.push({ Id: values[0], BusinessId: values[1], LocationId: values[2], Sku: values[3], Name: values[4],
            Unit: values[5], OnHand: values[6], Reserved: '0.000', ReorderLevel: values[7], Notes: values[8] ?? null });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO "StockMovements"')) {
          state.movements.push({ Id: values[0], BusinessId: values[1], MaterialId: values[2], Kind: 'Receive', Quantity: values[3],
            OnHandAfter: values[4], ReservedAfter: values[5], CreatedAtUtc: new Date().toISOString() });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
}

function upload(csvText, fields = {}) {
  const form = new FormData();
  form.append('file', new Blob([csvText], { type: 'text/csv' }), 'stock.csv');
  for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
  return form;
}

describe('inventory routes', () => {
  it('lists, creates, and exports only tenant-scoped inventory', async () => {
    const pool = inventoryPool();
    const create = await requestApp(createApp(env, pool), '/api/inventory', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'FAB-1', name: 'Cotton', unit: 'metre', locationId, openingStock: 2.125, reorderLevel: 0.5 }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.onHand, 2.125);

    const list = await requestApp(createApp(env, pool), '/api/inventory', { headers: { authorization: `Bearer ${bearer()}` } });
    assert.equal(list.status, 200);
    assert.equal(list.body[0].sku, 'FAB-1');

    const exported = await requestApp(createApp(env, pool), '/api/inventory/export', { headers: { authorization: `Bearer ${bearer()}` } });
    assert.equal(exported.status, 200);
    assert.match(exported.text, /Opening stock,Reorder level/);
    assert.match(exported.text, /FAB-1/);
  });

  it('validates material input and enforces authentication, permission, and location scope', async () => {
    const invalid = await requestApp(createApp(env, inventoryPool()), '/api/inventory', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'x' }),
    });
    assert.equal(invalid.status, 400);

    const csrf = newCsrfToken(env.JWT_SIGNING_KEY);
    const unauthenticated = await requestApp(createApp(env, inventoryPool()), '/api/inventory', {
      method: 'POST', headers: { cookie: `tailoring.csrf=${csrf}`, 'x-xsrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(env, inventoryPool({ owner: false, permissions: ['inventory.view'] })), '/api/inventory', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'FAB-1', name: 'Cotton', unit: 'metre', locationId, openingStock: 1, reorderLevel: 0 }),
    });
    assert.equal(forbidden.status, 403);

    const crossBusiness = await requestApp(createApp(env, inventoryPool({ activeBusiness: businessId })), '/api/inventory', {
      headers: { authorization: `Bearer ${bearer(otherBusinessId)}` },
    });
    assert.equal(crossBusiness.status, 401);

    const crossLocationPool = inventoryPool({ owner: false, permissions: ['inventory.view'], allowed: [] });
    crossLocationPool.state.materials.push({ Id: materialId, BusinessId: businessId, LocationId: locationId, Sku: 'FAB-2', Name: 'Linen', Unit: 'metre', OnHand: '1.000', Reserved: '0.000', ReorderLevel: '0.000' });
    const restricted = await requestApp(createApp(env, crossLocationPool), '/api/inventory', { headers: { authorization: `Bearer ${bearer()}` } });
    assert.equal(restricted.status, 200);
    assert.deepEqual(restricted.body, []);
  });

  it('previews and commits multipart CSV only when the preview hash matches', async () => {
    const pool = inventoryPool();
    const preview = await requestApp(createApp(env, pool), '/api/inventory/import/preview', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}` }, body: upload(csv),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.validRows, 1);
    const commit = await requestApp(createApp(env, pool), '/api/inventory/import/commit', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}` }, body: upload(csv, { expectedHash: preview.body.fileHash, skipInvalidRows: false }),
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.body.created, 1);
    const stale = await requestApp(createApp(env, pool), '/api/inventory/import/commit', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}` }, body: upload(`${csv}\n`, { expectedHash: preview.body.fileHash, skipInvalidRows: false }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'file_changed');
  });
});
