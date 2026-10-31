// The three webhooks and the background workers running against real PostgreSQL as a NOSUPERUSER, NOBYPASSRLS role.
// Skipped unless DATABASE_URL is set (CI job "node-db"). None of these paths has a signed token, so each must find its business by
// its own key (a payment reference, a provider message ID) or visit every business itself.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { installTenantRlsContext, runWithTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { forEachBusiness, sumResults } from '../../src/db/forEachBusiness.js';
import { handleReadyToWearWebhook } from '../../src/auth/readyToWearService.js';
import { handlePaystackWebhook } from '../../src/auth/subscriptionBillingService.js';
import { runLifecycleSweep } from '../../src/auth/subscriptionLifecycleService.js';
import { handleResendWebhook } from '../../src/email/webhookService.js';
import { dispatchOnce } from '../../src/email/dispatcher.js';
import { parseSecret, sign } from '../../src/email/svix.js';
import { TransportResult } from '../../src/email/transportResult.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const silent = { error() {}, warn() {}, info() {} };

describe('webhooks and workers under a restricted role', { skip: !url }, () => {
  let db;
  let roleName;
  let appPool;
  const A = randomUUID();
  const B = randomUUID();
  const ref = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rls_hooks');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    roleName = `avzar_hooks_${randomBytes(5).toString('hex')}`;
    await db.pool.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await db.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
    await db.pool.query(`
      INSERT INTO "Businesses" ("Id", "CreatedAtUtc", "CurrencyCode", "IsActive", "Name", "TimeZoneId")
      VALUES ($1, now(), 'NGN', true, 'Hooks A', 'UTC'), ($2, now(), 'NGN', true, 'Hooks B', 'UTC')`, [A, B]);
    const u = new URL(db.url);
    u.username = roleName;
    u.password = 'pw';
    appPool = installTenantRlsContext(new pg.Pool({ connectionString: u.toString(), max: 4 }));
  });

  after(async () => {
    await appPool?.end().catch(() => {});
    if (db) {
      await db.pool.query(`DROP OWNED BY "${roleName}"`).catch(() => {});
      await db.pool.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => {});
      await db.drop();
    }
  });

  it('the role really is restricted: with no tenant it sees no tenant rows', async () => {
    const { rows } = await runWithTenantRlsContext(() => appPool.query('SELECT "Id" FROM "Businesses"'));
    assert.equal(rows.length, 2, 'Businesses is the tenant directory and stays readable');
    const subs = await runWithTenantRlsContext(() => appPool.query('SELECT 1 FROM "Subscriptions"'));
    assert.equal(subs.rows.length, 0);
  });

  describe('ready-to-wear payment webhook', () => {
    const reference = ref('avzar_rtw_');
    const orderId = randomUUID();
    const variantId = randomUUID();
    const provider = {
      isConfigured: () => true,
      verifySignature: () => true,
      verify: async (value) => ({ status: 'success', reference: value, currency: 'NGN', amountMinor: 450000 }),
    };
    const body = (value) => Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: value } }));

    before(async () => {
      const designId = randomUUID();
      const storefrontId = randomUUID();
      await db.pool.query(`
        INSERT INTO "Designs" ("Id", "BusinessId", "CreatedAtUtc", "IsFeatured", "Kind", "Name", "Slug", "Status", "Visibility")
        VALUES ($1, $2, now(), false, 'Product', 'Kaftan', 'kaftan', 'Published', 'Public')`, [designId, A]);
      await db.pool.query(`
        INSERT INTO "Storefronts" ("Id", "BusinessId", "Slug", "Name", "Status", "TemplateKey", "DraftJson", "DraftRevision", "AllowSearchIndexing",
          "WorkflowBooking", "WorkflowContact", "WorkflowCustomOrder", "WorkflowInquiry", "CreatedAtUtc")
        VALUES ($1, $2, $3, 'Shop', 'Draft', 'luxury', '{}', 1, false, true, true, true, true, now())`, [storefrontId, A, `hooks-${randomBytes(3).toString('hex')}`]);
      await db.pool.query(`INSERT INTO "ReadyToWearVariants" ("Id", "BusinessId", "DesignId", "SKU", "OnHand", "Reserved") VALUES ($1, $2, $3, 'SKU-1', 5, 2)`, [variantId, A, designId]);
      await db.pool.query(`
        INSERT INTO "ReadyToWearOrders" ("Id", "BusinessId", "StorefrontId", "CustomerName", "Email", "Status", "CurrencyCode", "AmountMinor", "PaymentReference", "IdempotencyKey", "RequestHash")
        VALUES ($1, $2, $3, 'Ada', 'ada@example.test', 'PendingPayment', 'NGN', 450000, $4, 'idem-1', 'hash-1')`, [orderId, A, storefrontId, reference]);
      await db.pool.query(`INSERT INTO "ReadyToWearReservations" ("Id", "BusinessId", "OrderId", "VariantId", "Quantity") VALUES ($1, $2, $3, $4, 2)`, [randomUUID(), A, orderId, variantId]);
    });

    it('a payment with no tenant context still finds its order, consumes the stock and marks it Paid', async () => {
      assert.equal(await handleReadyToWearWebhook(appPool, provider, body(reference), 'signed', silent), 200);
      const order = (await db.pool.query('SELECT "Status", "PaidAtUtc" FROM "ReadyToWearOrders" WHERE "Id" = $1', [orderId])).rows[0];
      assert.equal(order.Status, 'Paid');
      assert.ok(order.PaidAtUtc);
      const variant = (await db.pool.query('SELECT "OnHand", "Reserved" FROM "ReadyToWearVariants" WHERE "Id" = $1', [variantId])).rows[0];
      assert.deepEqual({ onHand: variant.OnHand, reserved: variant.Reserved }, { onHand: 3, reserved: 0 });
      const reservation = (await db.pool.query('SELECT "Status" FROM "ReadyToWearReservations" WHERE "OrderId" = $1', [orderId])).rows[0];
      assert.equal(reservation.Status, 'Consumed');
    });

    it('replaying the same webhook changes nothing', async () => {
      assert.equal(await handleReadyToWearWebhook(appPool, provider, body(reference), 'signed', silent), 200);
      const variant = (await db.pool.query('SELECT "OnHand", "Reserved" FROM "ReadyToWearVariants" WHERE "Id" = $1', [variantId])).rows[0];
      assert.deepEqual({ onHand: variant.OnHand, reserved: variant.Reserved }, { onHand: 3, reserved: 0 });
    });

    it('a signed payment for a reference nobody owns answers 404 and is logged, never a silent 200', async () => {
      const lines = [];
      const status = await handleReadyToWearWebhook(appPool, provider, body(ref('avzar_rtw_')), 'signed', { error: (line) => lines.push(line) });
      assert.equal(status, 404);
      assert.match(lines.join('\n'), /rtw_webhook_unmatched_reference/);
    });
  });

  describe('subscription webhook and lifecycle sweep', () => {
    const reference = ref('avzar_sub_');
    const paymentId = randomUUID();
    const provider = {
      isConfigured: () => true,
      verifySignature: () => true,
      verify: async (value) => ({ status: 'success', reference: value, currency: 'NGN', amountMinor: 500000 }),
    };
    const body = (value) => Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: value } }));
    let planId;

    before(async () => {
      planId = (await db.pool.query(`SELECT "Id" FROM "Plans" WHERE "Code" <> 'free' ORDER BY "MonthlyPrice" LIMIT 1`)).rows[0].Id;
      await db.pool.query(`
        INSERT INTO "SubscriptionPayments" ("Id", "BusinessId", "PlanId", "BillingPeriod", "Amount", "CurrencyCode", "Provider", "ProviderReference", "Status", "CreatedAtUtc")
        VALUES ($1, $2, $3, 'monthly', 5000.00, 'NGN', 'paystack', $4, 'Pending', now())`, [paymentId, B, planId, reference]);
    });

    it('a renewal with no tenant context is applied to the right business, once', async () => {
      assert.equal(await handlePaystackWebhook(appPool, provider, body(reference), 'signed', silent), 200);
      const payment = (await db.pool.query('SELECT "Status" FROM "SubscriptionPayments" WHERE "Id" = $1', [paymentId])).rows[0];
      assert.equal(payment.Status, 'Paid');
      const first = (await db.pool.query('SELECT "Status", "PlanId", "CurrentPeriodEndUtc" FROM "Subscriptions" WHERE "BusinessId" = $1', [B])).rows;
      assert.equal(first.length, 1);
      assert.equal(first[0].Status, 'Active');
      assert.equal(first[0].PlanId, planId);
      assert.equal(await handlePaystackWebhook(appPool, provider, body(reference), 'signed', silent), 200);
      const second = (await db.pool.query('SELECT "CurrentPeriodEndUtc" FROM "Subscriptions" WHERE "BusinessId" = $1', [B])).rows;
      assert.equal(second.length, 1);
      assert.equal(new Date(second[0].CurrentPeriodEndUtc).getTime(), new Date(first[0].CurrentPeriodEndUtc).getTime());
    });

    it('an unknown reference answers 404', async () => {
      assert.equal(await handlePaystackWebhook(appPool, provider, body(ref('avzar_sub_')), 'signed', silent), 404);
    });

    it('the lifecycle sweep, run once per business, sees and moves only that business subscriptions', async () => {
      await db.pool.query(`UPDATE "Subscriptions" SET "Status" = 'Active', "CurrentPeriodEndUtc" = now() - interval '2 days' WHERE "BusinessId" = $1`, [B]);
      const results = await forEachBusiness(appPool, () => runLifecycleSweep(appPool, { graceDays: 7 }), { log: silent });
      const total = sumResults(results);
      assert.ok(total.events.some((event) => event.businessId === B && event.event === 'payment_overdue'));
      const row = (await db.pool.query('SELECT "Status" FROM "Subscriptions" WHERE "BusinessId" = $1', [B])).rows[0];
      assert.equal(row.Status, 'PastDue');
    });
  });

  describe('email dispatcher and Resend webhook', () => {
    const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
    const businessMail = randomUUID();
    const accountMail = randomUUID();
    const sent = [];
    const transport = { send: async ({ messageId, to }) => { sent.push(to); return TransportResult.ok(`prov_${messageId}`); } };
    const options = { leaseMinutes: 5, batchSize: 50, maxAttempts: 3 };

    before(async () => {
      const insert = (id, businessId) => db.pool.query(`
        INSERT INTO "EmailOutbox" ("Id", "Attempts", "BusinessId", "CreatedAtUtc", "NextAttemptUtc", "Status", "Subject", "TextBody", "ToAddress")
        VALUES ($1, 0, $2, now() - interval '1 minute', now() - interval '1 minute', 'Pending', 'Hello', 'Body', $3)`, [id, businessId, `${id}@example.test`]);
      await insert(businessMail, A);
      await insert(accountMail, null);
    });

    it('with no tenant context the dispatcher finds nothing to send', async () => {
      const handled = await runWithTenantRlsContext(() => dispatchOnce({ pool: appPool, transport, options, log: silent }));
      assert.equal(handled, 0);
      assert.equal(sent.length, 0);
    });

    it('one pass per business plus the platform pass sends both the business mail and the tenantless account mail', async () => {
      const handled = sumResults(await forEachBusiness(appPool, () => dispatchOnce({ pool: appPool, transport, options, log: silent }), { platform: true, log: silent }));
      assert.equal(handled, 2);
      const { rows } = await db.pool.query('SELECT "Id", "Status", "ProviderMessageId" FROM "EmailOutbox" WHERE "Id" = ANY($1::uuid[])', [[businessMail, accountMail]]);
      assert.deepEqual(rows.map((row) => row.Status), ['Sent', 'Sent']);
      assert.ok(rows.every((row) => row.ProviderMessageId?.startsWith('prov_')));
    });

    const event = (emailId) => {
      const bodyText = JSON.stringify({ type: 'email.delivered', data: { email_id: emailId } });
      const nowMs = Date.now();
      const timestamp = String(Math.floor(nowMs / 1000));
      return { secret, id: `evt_${randomBytes(4).toString('hex')}`, timestamp, body: bodyText, now: nowMs, log: silent,
        get signature() { return `v1,${sign(parseSecret(secret), this.id, timestamp, bodyText)}`; } };
    };

    it('a delivery event for a business mail and for an account mail are both recorded; an unknown message is acknowledged', async () => {
      for (const id of [businessMail, accountMail]) {
        const input = event(`prov_${id}`);
        assert.equal(await handleResendWebhook({ pool: appPool, ...input, signature: input.signature }), 'applied');
        const row = (await db.pool.query('SELECT "DeliveryStatus" FROM "EmailOutbox" WHERE "Id" = $1', [id])).rows[0];
        assert.equal(row.DeliveryStatus, 'Delivered');
      }
      const unknown = event('prov_no_such_message');
      assert.equal(await handleResendWebhook({ pool: appPool, ...unknown, signature: unknown.signature }), 'unknown_message');
    });
  });
});
