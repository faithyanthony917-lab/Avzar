import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyToWearCheckout, handleReadyToWearWebhook } from '../src/auth/readyToWearService.js';

describe('ready-to-wear payment webhook', () => {
  it('rejects unsigned webhook bodies before querying orders', async () => {
    const provider = { isConfigured: () => true, verifySignature: () => false };
    let queried = false;
    const pool = { query: async () => { queried = true; return { rows: [] }; } };
    const result = await handleReadyToWearWebhook(pool, provider, Buffer.from('{"event":"charge.success"}'), 'invalid');
    assert.equal(result, 401);
    assert.equal(queried, false);
  });

  it('rejects malformed raw webhook JSON after signature verification', async () => {
    const provider = { isConfigured: () => true, verifySignature: () => true };
    const result = await handleReadyToWearWebhook({ query: async () => ({ rows: [] }) }, provider, Buffer.from('{'), 'signed');
    assert.equal(result, 400);
  });
});

it('verifies the provider reference, amount and currency before consuming reserved stock', async () => {
  const orderId = '00000000-0000-4000-8000-000000000010';
  const businessId = '00000000-0000-4000-8000-000000000020';
  const variantId = '00000000-0000-4000-8000-000000000030';
  const reference = 'avzar_rtw_00000000000000000000000000000010';
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('WHERE "PaymentReference"=$1')) return { rows: [{ Id: orderId, AmountMinor: '450000', CurrencyCode: 'NGN', Status: 'PendingPayment' }] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (sql.includes('SELECT "Id","BusinessId","Status" FROM "ReadyToWearOrders"')) return { rows: [{ Id: orderId, BusinessId: businessId, Status: 'PendingPayment' }] };
          if (sql.includes('SELECT "VariantId","Quantity" FROM "ReadyToWearReservations"')) return { rows: [{ VariantId: variantId, Quantity: 2 }] };
          if (sql.includes('UPDATE "ReadyToWearVariants"')) return { rows: [], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
  const provider = {
    isConfigured: () => true,
    verifySignature: () => true,
    verify: async (value) => ({ status: 'success', reference: value, currency: 'NGN', amountMinor: 450000 }),
  };
  const status = await handleReadyToWearWebhook(pool, provider, Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference } })), 'signed');
  assert.equal(status, 200);
  assert.ok(calls.some((call) => call.sql.includes("SET \"OnHand\"=\"OnHand\"-$3,")));
  assert.ok(calls.some((call) => call.sql.includes("SET \"Status\"='Consumed'")));
  assert.ok(calls.some((call) => call.sql.includes("SET \"Status\"='Paid'")));
});


it('reserves stock once and reuses the same checkout for an idempotent retry', async () => {
  const businessId = '00000000-0000-4000-8000-000000000020';
  const storefrontId = '00000000-0000-4000-8000-000000000040';
  const designId = '00000000-0000-4000-8000-000000000050';
  const variantId = '00000000-0000-4000-8000-000000000030';
  const calls = [];
  let order = null;
  let reserved = 0;
  let initializes = 0;
  const product = { Id: variantId, DesignId: designId, SKU: 'TEE-M-BLK', Size: 'M', Colour: 'Black', OnHand: 5,
    Reserved: 0, IsActive: true, Name: 'Basic tee', BasePrice: '4500.00', CurrencyCode: 'NGN', Status: 'Active', Visibility: 'Public', Kind: 'ReadyMade' };
  const runQuery = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT "Enabled" FROM "PlatformFeatureFlags"')) return { rows: [{ Enabled: true }] };
    if (sql.includes('FROM "Storefronts" s JOIN "Businesses"')) return { rows: [{ Id: storefrontId, BusinessId: businessId, TemplateKey: 'ready-to-wear', BusinessName: 'Test Shop' }] };
    if (sql.includes('SELECT "Id","PaymentReference" FROM "ReadyToWearOrders"')) return { rows: [] };
    if (sql.includes('SELECT "Id","BusinessId","AmountMinor","CurrencyCode","PaymentReference","AuthorizationUrl","Status","RequestHash","ExpiresAtUtc"')) return { rows: order ? [{ ...order }] : [] };
    if (sql.includes('SELECT v."Id",v."DesignId"')) return { rows: [{ ...product, Reserved: reserved }] };
    if (sql.includes('INSERT INTO "ReadyToWearOrders"')) {
      order = { Id: values[0], BusinessId: values[1], AmountMinor: values[6], CurrencyCode: 'NGN', PaymentReference: values[7],
        AuthorizationUrl: null, Status: 'PendingPayment', RequestHash: values[9], ExpiresAtUtc: new Date(Date.now() + 60_000).toISOString() };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "ReadyToWearVariants" SET "Reserved"="Reserved"+')) { reserved += Number(values[2]); return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE "ReadyToWearOrders" SET "AuthorizationUrl"')) { if (order) order.AuthorizationUrl = values[1]; return { rows: [], rowCount: 1 }; }
    if (sql.includes('SELECT "Id","PaymentReference" FROM "ReadyToWearOrders"')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query: runQuery,
    async connect() {
      return {
        query: runQuery,
        release() {},
      };
    },
  };
  const provider = { isConfigured: () => true, initialize: async () => { initializes += 1; return { authorizationUrl: 'https://paystack.example/checkout' }; } };
  const request = { customerName: 'Ada Customer', email: 'ada@example.test', items: [{ variantId, quantity: 2 }] };
  const first = await createReadyToWearCheckout(pool, provider, {}, 'test-shop', request, 'stable-checkout-key');
  const second = await createReadyToWearCheckout(pool, provider, {}, 'test-shop', request, 'stable-checkout-key');
  assert.equal(first.authorizationUrl, 'https://paystack.example/checkout');
  assert.equal(second.authorizationUrl, first.authorizationUrl);
  assert.equal(second.reused, true);
  assert.equal(initializes, 1);
  assert.equal(reserved, 2);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO "ReadyToWearOrders"')).length, 1);
});
