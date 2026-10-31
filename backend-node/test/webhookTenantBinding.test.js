import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadyToWearWebhook } from '../src/auth/readyToWearService.js';
import { handlePaystackWebhook } from '../src/auth/subscriptionBillingService.js';
import { handleResendWebhook } from '../src/email/webhookService.js';
import { installTenantRlsContext } from '../src/db/tenantRlsContext.js';
import { parseSecret, sign } from '../src/email/svix.js';

// The three webhooks carry no token and no signed business. These tests give them a pool that behaves like a restricted role: a
// query returns rows only when the settings of its own transaction allow it, exactly as the policies of migrations 0032 and 0033 do.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER = '00000000-0000-4000-8000-000000000010';
const PAYMENT = '00000000-0000-4000-8000-000000000040';
const RTW_REF = 'avzar_rtw_00000000000000000000000000000010';

function restrictedPool(handle) {
  const queries = [];
  const run = (settingsRef) => async (sql, values = []) => {
    const text = typeof sql === 'string' ? sql : String(sql?.text ?? '');
    const settings = settingsRef.current;
    if (/^\s*BEGIN/i.test(text) || /^\s*(COMMIT|ROLLBACK)/i.test(text)) { settingsRef.current = {}; return { rows: [], rowCount: 0 }; }
    if (text.includes("set_config('app.business_id'")) { settings['app.business_id'] = values[0]; return { rows: [], rowCount: 0 }; }
    if (text.includes('unnest($1::text[]')) { values[0].forEach((key, i) => { settings[key] = values[1][i]; }); return { rows: [], rowCount: 0 }; }
    if (/^SELECT set_config\(\$1, \$2, true\)/.test(text)) { settings[values[0]] = values[1]; return { rows: [], rowCount: 0 }; }
    queries.push({ text, values, settings: { ...settings } });
    return handle(text, values, settings) ?? { rows: [], rowCount: 0 };
  };
  const pool = {
    queries,
    async query(sql, values) { return run({ current: {} })(sql, values); },
    async connect() { return { query: run({ current: {} }), release() {} }; },
  };
  return installTenantRlsContext(pool);
}

const quietLog = () => { const lines = []; return { lines, error: (m) => lines.push(m), warn: (m) => lines.push(m), info() {} }; };
const rtwBody = (reference) => Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference } }));
const rtwProvider = { isConfigured: () => true, verifySignature: () => true, verify: async (reference) => ({ status: 'success', reference, currency: 'NGN', amountMinor: 450000 }) };

function rtwHandler({ status = 'PendingPayment' } = {}) {
  return (text, values, settings) => {
    const inTenant = settings['app.business_id'] === A;
    if (text.includes('SELECT "BusinessId" FROM "ReadyToWearOrders"')) {
      return settings['app.lookup_rtw_payment_reference'] === values[0] ? { rows: [{ BusinessId: A }] } : { rows: [] };
    }
    if (text.includes('WHERE "PaymentReference"=$1')) return inTenant ? { rows: [{ Id: ORDER, AmountMinor: '450000', CurrencyCode: 'NGN', Status: status }] } : { rows: [] };
    if (text.includes('SELECT "Id","BusinessId","Status" FROM "ReadyToWearOrders"')) return inTenant ? { rows: [{ Id: ORDER, BusinessId: A, Status: status }] } : { rows: [] };
    if (text.includes('FROM "ReadyToWearReservations"') && text.startsWith('SELECT')) return inTenant ? { rows: [{ VariantId: '00000000-0000-4000-8000-000000000030', Quantity: 2 }] } : { rows: [] };
    return { rows: [], rowCount: inTenant ? 1 : 0 };
  };
}

test('ready-to-wear webhook finds its business by payment reference and marks the paid order Paid', async () => {
  const pool = restrictedPool(rtwHandler());
  assert.equal(await handleReadyToWearWebhook(pool, rtwProvider, rtwBody(RTW_REF), 'signed', quietLog()), 200);
  const paid = pool.queries.find((q) => q.text.includes(`SET "Status"='Paid'`));
  assert.ok(paid, 'the order must be marked Paid');
  assert.equal(paid.settings['app.business_id'], A);
  assert.ok(pool.queries.some((q) => q.text.includes(`SET "Status"='Consumed'`)));
  // The lookup key lived only for the lookup: once the business is known the keys are dropped.
  assert.equal(paid.settings['app.lookup_rtw_payment_reference'] ?? '', '');
});

test('ready-to-wear webhook: a signed payment that matches no order is logged and answered with 404 so the provider retries', async () => {
  const pool = restrictedPool(() => ({ rows: [] }));
  const log = quietLog();
  assert.equal(await handleReadyToWearWebhook(pool, rtwProvider, rtwBody(RTW_REF), 'signed', log), 404);
  assert.match(log.lines.join('\n'), /rtw_webhook_unmatched_reference/);
  assert.equal(pool.queries.some((q) => q.text.includes('"Status"=\'Paid\'')), false);
});

test('ready-to-wear webhook: a replay does nothing, and a paid order that is no longer pending is reported', async () => {
  const paidPool = restrictedPool(rtwHandler({ status: 'Paid' }));
  assert.equal(await handleReadyToWearWebhook(paidPool, rtwProvider, rtwBody(RTW_REF), 'signed', quietLog()), 200);
  assert.equal(paidPool.queries.some((q) => q.text.includes(`SET "Status"='Paid'`)), false);

  const expiredPool = restrictedPool(rtwHandler({ status: 'Expired' }));
  const log = quietLog();
  assert.equal(await handleReadyToWearWebhook(expiredPool, rtwProvider, rtwBody(RTW_REF), 'signed', log), 200);
  assert.match(log.lines.join('\n'), /rtw_webhook_paid_order_not_pending/);
  assert.equal(expiredPool.queries.some((q) => q.text.includes(`SET "Status"='Paid'`)), false);
});

const SUB_REF = 'avzar_sub_0001';
const subBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: SUB_REF } }));
const subProvider = { isConfigured: () => true, verifySignature: () => true, verify: async (reference) => ({ status: 'success', reference, currency: 'NGN', amountMinor: 500000 }) };

function subscriptionHandler(text, values, settings) {
  const inTenant = settings['app.business_id'] === A;
  if (text.includes('SELECT "BusinessId" FROM "SubscriptionPayments"')) {
    return settings['app.lookup_subscription_payment_reference'] === values[0] ? { rows: [{ BusinessId: A }] } : { rows: [] };
  }
  if (text.includes('FROM "SubscriptionPayments" WHERE "ProviderReference"')) return inTenant ? { rows: [{ Id: PAYMENT, Status: 'Pending', Amount: '5000.00', CurrencyCode: 'NGN' }] } : { rows: [] };
  if (text.includes('FROM "SubscriptionPayments" WHERE "Id" = $1 FOR UPDATE')) return inTenant ? { rows: [{ Id: PAYMENT, BusinessId: A, PlanId: 'plan', BillingPeriod: 'monthly', Status: 'Pending' }] } : { rows: [] };
  return { rows: [], rowCount: inTenant ? 1 : 0 };
}

test('subscription webhook records the renewal under the business named by the payment reference', async () => {
  const pool = restrictedPool(subscriptionHandler);
  assert.equal(await handlePaystackWebhook(pool, subProvider, subBody, 'signed', quietLog()), 200);
  const renewal = pool.queries.find((q) => q.text.includes('UPDATE "Subscriptions"'));
  assert.ok(renewal, 'the subscription must be extended');
  assert.equal(renewal.settings['app.business_id'], A);
});

test('subscription webhook: an unmatched reference is logged and answered with 404', async () => {
  const pool = restrictedPool(() => ({ rows: [] }));
  const log = quietLog();
  assert.equal(await handlePaystackWebhook(pool, subProvider, subBody, 'signed', log), 404);
  assert.match(log.lines.join('\n'), /subscription_webhook_unmatched_reference/);
});

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
function resendInput(emailId, log) {
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: emailId } });
  const nowMs = Date.now();
  const timestamp = String(Math.floor(nowMs / 1000));
  return { secret, id: 'evt_1', timestamp, signature: `v1,${sign(parseSecret(secret), 'evt_1', timestamp, body)}`, body, now: nowMs, log };
}

function emailHandler(owner) {
  return (text, values, settings) => {
    if (text.includes('SELECT "BusinessId" FROM "EmailOutbox"')) {
      return settings['app.lookup_email_provider_message_id'] === values[0] && owner !== 'none' ? { rows: [{ BusinessId: owner === 'business' ? A : null }] } : { rows: [] };
    }
    const visible = owner === 'business' ? settings['app.business_id'] === A : owner === 'platform' ? settings['app.platform_scope'] === 'on' && !settings['app.business_id'] : false;
    if (text.trim().startsWith('UPDATE "EmailOutbox"')) return { rows: [], rowCount: visible ? 1 : 0 };
    if (text.trim().startsWith('SELECT 1 FROM "EmailOutbox"')) return { rows: visible ? [{ x: 1 }] : [] };
    return { rows: [], rowCount: 0 };
  };
}

test('Resend webhook updates a business message under that business', async () => {
  const pool = restrictedPool(emailHandler('business'));
  assert.equal(await handleResendWebhook({ pool, ...resendInput('em_biz', quietLog()) }), 'applied');
  const update = pool.queries.find((q) => q.text.trim().startsWith('UPDATE "EmailOutbox"'));
  assert.equal(update.settings['app.business_id'], A);
  assert.equal(update.settings['app.platform_scope'], undefined);
});

test('Resend webhook reaches a tenantless account mail only through the platform scope', async () => {
  const pool = restrictedPool(emailHandler('platform'));
  assert.equal(await handleResendWebhook({ pool, ...resendInput('em_acct', quietLog()) }), 'applied');
  const update = pool.queries.find((q) => q.text.trim().startsWith('UPDATE "EmailOutbox"'));
  assert.equal(update.settings['app.platform_scope'], 'on');
  assert.equal(update.settings['app.business_id'], undefined);
});

test('Resend webhook: an unknown message is acknowledged but logged', async () => {
  const pool = restrictedPool(emailHandler('none'));
  const log = quietLog();
  assert.equal(await handleResendWebhook({ pool, ...resendInput('em_nobody', log) }), 'unknown_message');
  assert.match(log.lines.join('\n'), /resend_webhook_unknown_message/);
});
