import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

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
import { calculatePricing } from '../src/auth/pricingService.js';

function bearerToken(userId = '00000000-0000-4000-8000-000000000001', businessId = '00000000-0000-4000-8000-000000000002', sessionId = '00000000-0000-4000-8000-000000000003') {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId }).token;
}


const BUSINESS = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000001';
const ORDER = '00000000-0000-4000-8000-000000000050';
const CUSTOMER = '00000000-0000-4000-8000-000000000010';
const LOCATION = '00000000-0000-4000-8000-000000000060';
const GARMENT = '00000000-0000-4000-8000-000000000070';
const SET = '00000000-0000-4000-8000-000000000081';
const DESIGN = '00000000-0000-4000-8000-000000000091';
const PROMISED = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

const orderRecord = {
  Id: ORDER, OrderNumber: 'ORD-2026-00001', Status: 'Draft', CustomerId: CUSTOMER, CustomerName: 'Nia Adebayo', LocationId: LOCATION,
  PromisedDate: PROMISED, Priority: 'Normal', DeliveryMethod: 'Collection', CurrencyCode: 'NGN', Subtotal: '100.00', Discount: '0.00',
  Total: '100.00', Version: 7, CreatedAtUtc: new Date('2026-01-01T00:00:00.000Z'),
};
const PRICING = { materials: [{ name: 'Linen', quantity: 2, unitCost: 50 }], labour: [], other: [], complexityMultiplier: 1 };

// A fake pool: `existing` is the garment row an update finds; `captured` records what is written to OrderGarments.
function makePool({ isOwner = true, permissions = [], existing = null, revisionRows = null } = {}) {
  const captured = { insert: null, update: null };
  const domainQuery = async (sql, values) => {
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'unlimited' }] };
    if (sql.includes('INSERT INTO "UsageCounters"')) return { rows: [{ Count: '1' }] };
    if (sql.includes('FROM "Locations"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Customers"') && sql.includes('"Status"')) return { rows: [{ Id: CUSTOMER, Status: 'Active' }] };
    if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', Today: '2026-01-01' }] };
    if (sql.includes('INSERT INTO "OrderCounters"')) return { rows: [{ LastValue: '1' }] };
    if (sql.includes('INSERT INTO "OrderGarments"')) { captured.insert = values; return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE "OrderGarments" SET "LineNumber"')) { captured.update = values; return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE "Orders" SET "LocationId"')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT *, xmin::text::bigint AS "Version" FROM "Orders"')) return { rows: [orderRecord] };
    if (sql.includes('SELECT o.*, o.xmin::text::bigint AS "Version"')) return { rows: [orderRecord] };
    if (sql.includes('"DesignNameSnapshot", "DesignPriceSnapshot", "PricingSnapshotJson"')) return { rows: existing ? [existing] : [] };
    if (sql.includes('SELECT "Id" FROM "OrderGarments"') && sql.includes('FOR UPDATE')) return { rows: [{ Id: GARMENT }] };
    if (sql.includes('FROM "MeasurementSets" s')) return { rows: [{ CurrentRevision: 2, Label: 'Main', TemplateId: 'tpl' }] };
    if (sql.includes('FROM "MeasurementRevisions"')) return { rows: revisionRows ?? [{ RevisionNumber: values[2], ValuesJson: { chest: 90 }, Notes: null, CreatedAtUtc: new Date('2026-01-01T00:00:00.000Z') }] };
    if (sql.includes('FROM "MeasurementTemplates"')) return { rows: [{ Name: 'Suit' }] };
    if (sql.includes('FROM "OrderGarments"')) return { rows: [] };
    if (sql.includes('FROM "ProductionTasks"')) return { rows: [] };
    if (sql.includes('FROM "Orders"') && sql.includes('"IdempotencyKey"')) return { rows: [] };
    return { rows: [] };
  };
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships"')) {
        return { rows: [{ UserId: USER, BusinessId: BUSINESS, Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: isOwner, Permissions: permissions }] };
      }
      return domainQuery(sql, values);
    },
    connect: async () => ({ query: domainQuery, release() {} }),
  };
  return { pool, captured };
}

const headers = () => ({ authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' });
const createOrder = (app, garment) => requestApp(app, '/api/orders', {
  method: 'POST', headers: headers(),
  body: JSON.stringify({ customerId: CUSTOMER, locationId: LOCATION, promisedDate: PROMISED, discount: 0, garments: [garment] }),
});
const updateOrder = (app, garment) => requestApp(app, `/api/orders/${ORDER}`, {
  method: 'PUT', headers: headers(),
  body: JSON.stringify({ locationId: LOCATION, promisedDate: PROMISED, discount: 0, version: 7, garments: [{ id: GARMENT, ...garment }] }),
});
// OrderGarments insert/update value positions: 5 category, 14 design name, 15 design price, 16 measurement set, 17 revision,
// 18 measurement snapshot, 19 pricing snapshot, 20 price override reason.

describe('order garment pricing (C# OrderService.ApplyPricingAsync)', () => {
  it('recomputes the calculator price, stores a snapshot, and drops the reason when the price matches', async () => {
    const { pool, captured } = makePool();
    const calculated = await calculatePricing(pool, BUSINESS, PRICING);
    const suggested = calculated.result.unitPrice;
    const res = await createOrder(createApp(env, pool), { name: 'Suit', quantity: 1, unitPrice: suggested, pricing: PRICING, priceOverrideReason: 'not needed' });
    assert.equal(res.status, 201);
    const snapshot = JSON.parse(captured.insert[19]);
    assert.equal(snapshot.suggestedUnitPrice, suggested);
    assert.equal(snapshot.finalUnitPrice, suggested);
    assert.deepEqual(snapshot.result, calculated.result);
    assert.deepEqual(snapshot.input.materials, PRICING.materials);
    assert.equal(captured.insert[20], null);
  });

  it('requires a reason of at least 3 characters when the price differs from the calculated one', async () => {
    const { pool, captured } = makePool();
    const suggested = (await calculatePricing(pool, BUSINESS, PRICING)).result.unitPrice;
    const app = createApp(env, pool);
    const higher = Number((suggested + 10).toFixed(2));

    for (const reason of [undefined, '  ', 'ab']) {
      const res = await createOrder(app, { name: 'Suit', quantity: 1, unitPrice: higher, pricing: PRICING, priceOverrideReason: reason });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'override_reason_required');
    }
    assert.equal(captured.insert, null);

    const ok = await createOrder(app, { name: 'Suit', quantity: 1, unitPrice: higher, pricing: PRICING, priceOverrideReason: '  Loyal customer  ' });
    assert.equal(ok.status, 201);
    assert.equal(captured.insert[20], 'Loyal customer');
    assert.equal(JSON.parse(captured.insert[19]).finalUnitPrice, higher);
  });

  it('rejects a reason without calculator pricing, and calculator pricing without the pricing permission', async () => {
    const { pool } = makePool();
    const without = await createOrder(createApp(env, pool), { name: 'Suit', quantity: 1, unitPrice: 100, priceOverrideReason: 'Because' });
    assert.equal(without.status, 400);
    assert.equal(without.body.code, 'override_without_pricing');

    const limited = makePool({ isOwner: false, permissions: ['orders.manage', 'locations.all'] });
    const denied = await createOrder(createApp(env, limited.pool), { name: 'Suit', quantity: 1, unitPrice: 100, pricing: PRICING });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'permission_denied');

    const allowed = makePool({ isOwner: false, permissions: ['orders.manage', 'locations.all', 'pricing.view'] });
    const suggested = (await calculatePricing(allowed.pool, BUSINESS, PRICING)).result.unitPrice;
    const ok = await createOrder(createApp(env, allowed.pool), { name: 'Suit', quantity: 1, unitPrice: suggested, pricing: PRICING });
    assert.equal(ok.status, 201);
  });
});

describe('order update keeps frozen snapshots like C# BuildGarmentAsync', () => {
  const frozen = { templateName: 'Suit', profile: 'Main', revision: 2, recordedAtUtc: '2025-12-01T00:00:00.000Z', notes: null, values: { chest: 88 } };
  const pricingSnapshot = { suggestedUnitPrice: 150, finalUnitPrice: 150, result: { unitPrice: 150 } };
  const existingRow = () => ({
    UnitPrice: '150.00', MeasurementSetId: SET, MeasurementRevision: 2, MeasurementSnapshotJson: frozen, DesignId: DESIGN,
    DesignNameSnapshot: 'Old design name', DesignPriceSnapshot: '300.00', PricingSnapshotJson: pricingSnapshot, PriceOverrideReason: 'Loyal customer',
  });
  const sameGarment = { name: 'Suit', quantity: 1, unitPrice: 100, measurementSetId: SET, designId: DESIGN };

  it('keeps the measurement and design snapshots, category and pricing snapshot of an unchanged line', async () => {
    const { pool, captured } = makePool({ existing: { ...existingRow(), UnitPrice: '100.00' } });
    const res = await updateOrder(createApp(env, pool), sameGarment);
    assert.equal(res.status, 200);
    const values = captured.update;
    assert.equal(values[5], null, 'category is not defaulted when the snapshot is kept');
    assert.equal(values[14], 'Old design name');
    assert.equal(values[15], '300.00');
    assert.equal(values[16], SET);
    assert.equal(values[17], 2);
    assert.deepEqual(JSON.parse(values[18]), frozen);
    assert.deepEqual(JSON.parse(values[19]), pricingSnapshot);
    assert.equal(values[20], 'Loyal customer');
  });

  it('drops the pricing snapshot and reason when the manual price changes', async () => {
    const { pool, captured } = makePool({ existing: existingRow() });
    const res = await updateOrder(createApp(env, pool), { ...sameGarment, unitPrice: 175 });
    assert.equal(res.status, 200);
    assert.equal(captured.update[19], null);
    assert.equal(captured.update[20], null);
    assert.deepEqual(JSON.parse(captured.update[18]), frozen);
  });

  it('takes a new snapshot only when a different revision is picked, and reports an unknown revision', async () => {
    const { pool, captured } = makePool({ existing: { ...existingRow(), UnitPrice: '100.00' } });
    const res = await updateOrder(createApp(env, pool), { ...sameGarment, measurementRevision: 1 });
    assert.equal(res.status, 200);
    assert.equal(captured.update[17], 1);
    assert.equal(JSON.parse(captured.update[18]).revision, 1);
    assert.equal(captured.update[5], 'Suit');

    const missing = makePool({ existing: { ...existingRow(), UnitPrice: '100.00' }, revisionRows: [] });
    const bad = await updateOrder(createApp(env, missing.pool), { ...sameGarment, measurementRevision: 9 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'unknown_revision');
  });

  it('ignores a measurement revision without a profile, like C#', async () => {
    const { pool, captured } = makePool({ existing: null });
    const res = await createOrder(createApp(env, pool), { name: 'Suit', quantity: 1, unitPrice: 100, measurementRevision: 3 });
    assert.equal(res.status, 201);
    assert.equal(captured.insert[16], null);
    assert.equal(captured.insert[17], null);
    assert.equal(captured.insert[18], null);
  });
});
