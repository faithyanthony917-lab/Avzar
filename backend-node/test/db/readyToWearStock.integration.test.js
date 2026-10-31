// Ready-to-wear stock reservation, idempotent checkout, cancellation and expiry against real PostgreSQL, with a fake
// payment provider. (The payment webhook is covered in rls-webhooks-workers; checkout under a restricted role is step-09c.)
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { cancelReadyToWearOrder, createReadyToWearCheckout } from '../../src/auth/readyToWearService.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const UNIT_PRICE = 15000; // naira; 1,500,000 kobo
const ENV = { PUBLIC_BASE_URL: 'https://shop.example.test' };

describe('ready-to-wear stock, checkout, cancellation and expiry on PostgreSQL', { skip: !url }, () => {
  let db; let designId; let storefrontSlug;
  const A = randomUUID();
  const B = randomUUID();
  const state = { verify: 'pending', verifyThrows: false, initialized: [] };
  const provider = {
    isConfigured: () => true,
    initialize: async (input) => { state.initialized.push(input); return { authorizationUrl: `https://pay.example.test/${input.reference}` }; },
    verify: async (reference) => {
      if (state.verifyThrows) throw new Error('provider outage');
      return { status: state.verify, reference };
    },
  };

  async function variant(onHand) {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO "ReadyToWearVariants" ("Id","BusinessId","DesignId","SKU","OnHand","Reserved") VALUES ($1,$2,$3,$4,$5,0)`,
      [id, A, designId, `SKU-${randomBytes(3).toString('hex')}`, onHand]);
    return id;
  }
  const stock = async (id) => (await db.pool.query('SELECT "OnHand","Reserved" FROM "ReadyToWearVariants" WHERE "Id" = $1', [id])).rows[0];
  const order = async (id) => (await db.pool.query('SELECT "Status","AuthorizationUrl","AmountMinor","PaymentReference" FROM "ReadyToWearOrders" WHERE "Id" = $1', [id])).rows[0];
  const reservations = async (orderId) => (await db.pool.query('SELECT "Status","Quantity" FROM "ReadyToWearReservations" WHERE "OrderId" = $1', [orderId])).rows;
  const request = (variantId, quantity = 1) => ({ customerName: 'Ada Buyer', email: 'ada@example.test', items: [{ variantId, quantity }] });
  const checkout = (req, key = `idem-${randomUUID()}`) => createReadyToWearCheckout(db.pool, provider, ENV, storefrontSlug, req, key);
  const setFlag = (enabled) => db.pool.query(`UPDATE "PlatformFeatureFlags" SET "Enabled" = $1 WHERE "Key" = 'ready_to_wear_checkout'`, [enabled]);
  const code = (expected) => (error) => { assert.equal(error.code, expected, `got ${error.code}: ${error.message}`); return true; };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rtw_stock');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    for (const [id, name] of [[A, 'Stock A'], [B, 'Stock B']]) {
      await db.pool.query(`INSERT INTO "Businesses" ("Id","CreatedAtUtc","CurrencyCode","IsActive","Name","TimeZoneId") VALUES ($1, now(), 'NGN', TRUE, $2, 'UTC')`, [id, name]);
    }
    storefrontSlug = `stock-${randomBytes(3).toString('hex')}`;
    const storefrontId = randomUUID();
    const versionId = randomUUID();
    await db.pool.query(`
      INSERT INTO "Storefronts" ("Id","BusinessId","Slug","Name","Status","TemplateKey","DraftJson","DraftRevision","AllowSearchIndexing","WorkflowBooking","WorkflowContact","WorkflowCustomOrder","WorkflowInquiry","CreatedAtUtc")
      VALUES ($1,$2,$3,'Shop','Draft','luxury','{}',1,FALSE,TRUE,TRUE,TRUE,TRUE,now())`, [storefrontId, A, storefrontSlug]);
    await db.pool.query(`INSERT INTO "StorefrontVersions" ("Id","BusinessId","CreatedAtUtc","DocumentJson","SchemaVersion","StorefrontId","TemplateKey","VersionNumber") VALUES ($1,$2,now(),'{"pages":[]}',1,$3,'luxury',1)`, [versionId, A, storefrontId]);
    await db.pool.query(`UPDATE "Storefronts" SET "Status" = 'Published', "PublishedVersionId" = $1 WHERE "Id" = $2`, [versionId, storefrontId]);
    designId = randomUUID();
    await db.pool.query(`
      INSERT INTO "Designs" ("Id","BusinessId","CreatedAtUtc","IsFeatured","Kind","Name","Slug","Status","Visibility","BasePrice","CurrencyCode")
      VALUES ($1,$2,now(),FALSE,'ReadyMade','Kaftan','kaftan','Active','Public',$3,'NGN')`, [designId, A, UNIT_PRICE]);
    await setFlag(true);
  });
  after(async () => { await db?.drop(); });

  it('a checkout reserves the stock, records the reservation and charges the right amount', async () => {
    const id = await variant(5);
    const result = await checkout(request(id, 2));
    assert.equal(result.reused, false);
    assert.match(result.authorizationUrl, /^https:\/\/pay\.example\.test\/avzar_rtw_/);
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 2 });
    assert.deepEqual(await reservations(result.orderId), [{ Status: 'Reserved', Quantity: 2 }]);
    const saved = await order(result.orderId);
    assert.equal(saved.Status, 'PendingPayment');
    assert.equal(Number(saved.AmountMinor), 2 * UNIT_PRICE * 100);
    assert.match(saved.PaymentReference, /^avzar_rtw_[0-9a-f]{32}$/);
    const sent = state.initialized.at(-1);
    assert.equal(sent.amountMinor, 2 * UNIT_PRICE * 100);
    assert.equal(sent.reference, saved.PaymentReference);
  });

  it('replaying the same idempotency key reuses the order and reserves nothing more', async () => {
    const id = await variant(5);
    const key = `idem-${randomUUID()}`;
    const first = await checkout(request(id, 1), key);
    const replay = await checkout(request(id, 1), key);
    assert.equal(replay.orderId, first.orderId);
    assert.equal(replay.reused, true);
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 1 });
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "ReadyToWearOrders" WHERE "IdempotencyKey" = $1', [key])).rows[0].n, 1);
  });

  it('the same key with a different basket is refused and reserves nothing', async () => {
    const id = await variant(5);
    const key = `idem-${randomUUID()}`;
    await checkout(request(id, 1), key);
    await assert.rejects(checkout(request(id, 2), key), code('idempotency_key_reused'));
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 1 });
  });

  it('refuses to oversell, and a missing or oversized key, and a disabled checkout', async () => {
    const id = await variant(2);
    await assert.rejects(checkout(request(id, 3)), code('insufficient_stock'));
    assert.deepEqual(await stock(id), { OnHand: 2, Reserved: 0 });
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "ReadyToWearReservations" WHERE "VariantId" = $1', [id])).rows[0].n, 0);
    await assert.rejects(checkout(request(id, 1), ''), code('idempotency_key_required'));
    await assert.rejects(checkout(request(id, 1), 'k'.repeat(121)), code('idempotency_key_required'));
    await setFlag(false);
    try { await assert.rejects(checkout(request(id, 1)), code('checkout_disabled')); } finally { await setFlag(true); }
    assert.deepEqual(await stock(id), { OnHand: 2, Reserved: 0 });
  });

  it('cancelling keeps the stock while the provider still reports the payment as pending, or cannot be asked', async () => {
    const id = await variant(5);
    const { orderId } = await checkout(request(id, 2));
    state.verify = 'pending';
    await assert.rejects(cancelReadyToWearOrder(db.pool, provider, { businessId: A }, orderId), code('ready_to_wear_payment_not_terminal'));
    state.verifyThrows = true;
    try { await assert.rejects(cancelReadyToWearOrder(db.pool, provider, { businessId: A }, orderId), code('payment_status_unavailable')); } finally { state.verifyThrows = false; }
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 2 });
    assert.equal((await order(orderId)).Status, 'PendingPayment');
  });

  it('cancelling an abandoned payment releases the stock once, and a second cancel changes nothing', async () => {
    const id = await variant(5);
    const { orderId } = await checkout(request(id, 2));
    state.verify = 'abandoned';
    const cancelled = await cancelReadyToWearOrder(db.pool, provider, { businessId: A }, orderId);
    assert.deepEqual(cancelled, { id: orderId, status: 'Cancelled', reused: false });
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 0 });
    assert.deepEqual(await reservations(orderId), [{ Status: 'Released', Quantity: 2 }]);
    assert.equal((await order(orderId)).Status, 'Cancelled');
    const again = await cancelReadyToWearOrder(db.pool, provider, { businessId: A }, orderId);
    assert.equal(again.reused, true);
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 0 });
    state.verify = 'pending';
  });

  it('another business cannot cancel the order and the stock stays reserved', async () => {
    const id = await variant(5);
    const { orderId } = await checkout(request(id, 1));
    state.verify = 'abandoned';
    try { await assert.rejects(cancelReadyToWearOrder(db.pool, provider, { businessId: B }, orderId), code('ready_to_wear_order_not_found')); } finally { state.verify = 'pending'; }
    assert.equal((await order(orderId)).Status, 'PendingPayment');
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 1 });
  });

  it('an expired checkout is released only when the provider reports it failed or abandoned', async () => {
    const id = await variant(5);
    const { orderId } = await checkout(request(id, 2));
    await db.pool.query(`UPDATE "ReadyToWearOrders" SET "ExpiresAtUtc" = now() - interval '1 hour' WHERE "Id" = $1`, [orderId]);
    const trigger = async () => { const spare = await variant(1); await checkout(request(spare, 1)); };

    state.verify = 'pending';
    await trigger();
    assert.equal((await order(orderId)).Status, 'PendingPayment', 'a pending payment must keep its stock');
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 2 });

    state.verifyThrows = true;
    try { await trigger(); } finally { state.verifyThrows = false; }
    assert.equal((await order(orderId)).Status, 'PendingPayment', 'a provider outage must never free stock');
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 2 });

    state.verify = 'abandoned';
    try { await trigger(); } finally { state.verify = 'pending'; }
    assert.equal((await order(orderId)).Status, 'Expired');
    assert.deepEqual(await stock(id), { OnHand: 5, Reserved: 0 });
    assert.deepEqual(await reservations(orderId), [{ Status: 'Released', Quantity: 2 }]);
  });
});
