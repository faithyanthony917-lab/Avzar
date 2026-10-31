// Step 16b: the dispatcher for order and payment messages: lease, consent re-check, current-facts re-check, retry and stop handling.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCustomerEventsOnce } from '../src/messaging/customerEventWorker.js';
import { verifyUnsubscribeToken } from '../src/messaging/optOut.js';
import { MessagingProviderError } from '../src/messaging/provider.js';

const PREFERENCE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENV = { JWT_SIGNING_KEY: 'k'.repeat(40), WEB_BASE_URL: 'https://app.example.com/' };
const NOW = new Date('2026-10-28T12:00:00.000Z');
const JOB = {
  Id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', BusinessId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', CustomerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  Channel: 'SMS', Address: '+2348000000000', Kind: 'order.ready', SubjectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  LeaseUntilUtc: new Date(NOW.getTime() + 60_000), Attempts: 1,
};
const ORDER = { OrderNumber: 'ORD-2026-0042', Status: 'Ready', PromisedDate: '2026-11-12', Total: '45000.00', DeliveryMethod: 'Collection', BusinessName: 'Taratara Atelier', CurrencyCode: 'NGN' };

function mockPool({ consent = true, suppressed = false, order = ORDER, job = JOB, template = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT "Body" FROM "NotificationTemplates"')) return { rows: template && params[2] === template.channel ? [{ Body: template.body }] : [], rowCount: template ? 1 : 0 };
      if (normalized.startsWith('UPDATE "CustomerEventOutbox" SET "Status"=\'Failed\'')) return { rows: [], rowCount: 0 };
      if (normalized.startsWith('WITH picked AS')) return { rows: [{ ...job, LeaseUntilUtc: params[1] }], rowCount: 1 };
      if (normalized.startsWith('SELECT 1 FROM "MessagingSuppressions"')) return { rows: suppressed ? [{ '?column?': 1 }] : [], rowCount: suppressed ? 1 : 0 };
      if (normalized.startsWith('SELECT 1 FROM "CustomerMessagingPreferences"')) return { rows: consent ? [{ '?column?': 1 }] : [], rowCount: consent ? 1 : 0 };
      if (normalized.includes('FROM "Orders" o JOIN "Businesses" b')) return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
      if (normalized.startsWith('SELECT "Id" FROM "CustomerMessagingPreferences"')) return { rows: [{ Id: PREFERENCE_ID }], rowCount: 1 };
      if (normalized.startsWith('INSERT INTO "MessagingSuppressions"')) return { rows: [], rowCount: 1 };
      if (normalized.startsWith('UPDATE "CustomerEventOutbox" SET "Status"=\'Sent\'')) return { rows: [], rowCount: 1 };
      if (normalized.startsWith('UPDATE "CustomerEventOutbox" SET "Status"=\'Cancelled\'')) return { rows: [], rowCount: 1 };
      if (normalized.startsWith('UPDATE "CustomerEventOutbox" SET "Status"=$3')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test mock: ${normalized.slice(0, 100)}`);
    },
  };
}
const run = (pool, provider, extra = {}) => dispatchCustomerEventsOnce(pool, { now: NOW, provider, log: { error() {} }, ...extra });

describe('customer event message worker', () => {
  it('sends only after checking consent and the order as it is now, with a way out in the text', async () => {
    const pool = mockPool();
    const sent = [];
    const result = await run(pool, { async send(message) { sent.push(message); return { providerMessageId: 'provider-1' }; } }, { env: ENV });
    assert.deepEqual(result, { claimed: 1, sent: 1, cancelled: 0, retried: 0, failed: 0 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].idempotencyKey, `avzar-customer-event-${JOB.Id}`);
    assert.equal(sent[0].to, '+2348000000000');
    assert.match(sent[0].text, /^Good news from Taratara Atelier: order ORD-2026-0042 is ready\. It is ready for collection\. Reply STOP to opt out\. Unsubscribe: https:\/\/app\.example\.com\//);
    const token = sent[0].text.split('#').pop();
    assert.equal(verifyUnsubscribeToken(ENV.JWT_SIGNING_KEY, token)?.preferenceId, PREFERENCE_ID);
    assert.ok(pool.calls.some((call) => call.sql.startsWith('SELECT 1 FROM "CustomerMessagingPreferences"')), 'consent is read again before sending');
    assert.ok(pool.calls.some((call) => call.sql.includes('FROM "Orders" o')), 'the order is read again before sending');
    assert.ok(pool.calls.some((call) => call.sql.includes('"Status"=\'Sent\'')));
  });

  it('WhatsApp messages carry the unsubscribe link but not the SMS "Reply STOP" line', async () => {
    const pool = mockPool({ job: { ...JOB, Channel: 'WhatsApp' } });
    const sent = [];
    await run(pool, { async send(message) { sent.push(message); return { providerMessageId: 'provider-2' }; } }, { env: ENV });
    assert.ok(!sent[0].text.includes('Reply STOP'));
    assert.match(sent[0].text, /Unsubscribe: https:\/\/app\.example\.com\//);
  });

  it('step 16d: WhatsApp starts the conversation with the Meta-approved template (the same facts, the opt-out link last); SMS sends no template', async () => {
    const sent = [];
    await run(mockPool({ job: { ...JOB, Channel: 'WhatsApp' } }), { async send(message) { sent.push(message); return { providerMessageId: 'w1' }; } }, { env: { ...ENV, META_WHATSAPP_TEMPLATE_LANGUAGE: 'en_GB' } });
    const link = sent[0].text.split('Unsubscribe: ')[1];
    assert.match(link, /^https:\/\/app\.example\.com\/unsubscribe#/);
    assert.deepEqual(sent[0].template, { name: 'avzar_order_ready', language: 'en_GB', parameters: ['Taratara Atelier', 'ORD-2026-0042', 'It is ready for collection.', link] });
    const sms = [];
    await run(mockPool(), { async send(message) { sms.push(message); return { providerMessageId: 's1' }; } }, { env: ENV });
    assert.equal(sms[0].template, undefined);
  });

  it('step 16d: a saved WhatsApp wording is not read or used; the template is sent', async () => {
    const pool = mockPool({ job: { ...JOB, Channel: 'WhatsApp' }, template: { channel: 'WhatsApp', body: 'Custom {order}' } });
    const sent = [];
    await run(pool, { async send(message) { sent.push(message); return { providerMessageId: 'w2' }; } }, { env: ENV });
    assert.ok(!pool.calls.some((call) => call.sql.includes('"NotificationTemplates"')));
    assert.ok(!sent[0].text.includes('Custom'));
    assert.equal(sent[0].template.name, 'avzar_order_ready');
  });

  it('step 16d: a template error from Meta fails the message with its code and does not retry', async () => {
    const pool = mockPool({ job: { ...JOB, Channel: 'WhatsApp' } });
    const result = await run(pool, { async send() { throw new MessagingProviderError('WhatsApp provider rejected the request.', { retryable: false, code: 'whatsapp_meta_132001' }); } }, { env: ENV });
    assert.deepEqual(result, { claimed: 1, sent: 0, cancelled: 0, retried: 0, failed: 1 });
    const update = pool.calls.find((call) => call.sql.startsWith('UPDATE "CustomerEventOutbox" SET "Status"=$3'));
    assert.deepEqual([update.params[2], update.params[4]], ['Failed', 'whatsapp_meta_132001']);
  });

  it('step 16c: sends the business\'s saved wording for the channel, and the opt-out line is still added after it', async () => {
    const pool = mockPool({ template: { channel: 'SMS', body: 'Hi! {order} is ready at {business}.' } });
    const sent = [];
    await run(pool, { async send(message) { sent.push(message); return { providerMessageId: 'p' }; } }, { env: ENV });
    assert.match(sent[0].text, /^Hi! ORD-2026-0042 is ready at Taratara Atelier\. Reply STOP to opt out\. Unsubscribe: https:\/\/app\.example\.com\//);
    assert.deepEqual(pool.calls.find((call) => call.sql.includes('"NotificationTemplates"')).params, [JOB.BusinessId, 'order.ready', 'SMS']);
    const other = mockPool({ template: { channel: 'WhatsApp', body: 'Only for WhatsApp {order}' } });
    const sentSms = [];
    await run(other, { async send(message) { sentSms.push(message); return { providerMessageId: 'p' }; } }, { env: ENV });
    assert.match(sentSms[0].text, /^Good news from Taratara Atelier: order ORD-2026-0042 is ready\./, 'a WhatsApp wording is not used for SMS');
  });

  it('step 16c: a saved wording does not stop the order check: a message for an order that is no longer Ready is still cancelled', async () => {
    const pool = mockPool({ order: { ...ORDER, Status: 'InProduction' }, template: { channel: 'SMS', body: 'Ready {order}' } });
    let sends = 0;
    const result = await run(pool, { async send() { sends += 1; return { providerMessageId: 'x' }; } });
    assert.equal(result.cancelled, 1);
    assert.equal(sends, 0);
  });

  it('cancels a queued message when consent has been withdrawn, without reading the order or sending', async () => {
    const pool = mockPool({ consent: false });
    let sends = 0;
    const result = await run(pool, { async send() { sends += 1; return { providerMessageId: 'x' }; } });
    assert.deepEqual(result, { claimed: 1, sent: 0, cancelled: 1, retried: 0, failed: 0 });
    assert.equal(sends, 0);
    assert.ok(!pool.calls.some((call) => call.sql.includes('FROM "Orders" o')));
    assert.ok(pool.calls.some((call) => call.sql.includes('"Status"=\'Cancelled\'')));
  });

  it('cancels a message whose standing sender-wide stop appeared after it was queued', async () => {
    const pool = mockPool({ suppressed: true });
    let sends = 0;
    const result = await run(pool, { async send() { sends += 1; return { providerMessageId: 'x' }; } });
    assert.equal(result.cancelled, 1);
    assert.equal(sends, 0);
  });

  it('cancels a message when the order is no longer Ready', async () => {
    const pool = mockPool({ order: { ...ORDER, Status: 'InProduction' } });
    let sends = 0;
    const result = await run(pool, { async send() { sends += 1; return { providerMessageId: 'x' }; } });
    assert.deepEqual(result, { claimed: 1, sent: 0, cancelled: 1, retried: 0, failed: 0 });
    assert.equal(sends, 0);
  });

  it('retries a provider outage, and fails a provider error that cannot be retried', async () => {
    const outage = await run(mockPool(), { async send() { throw new MessagingProviderError('down', { retryable: true, code: 'sms_http_503' }); } });
    assert.deepEqual(outage, { claimed: 1, sent: 0, cancelled: 0, retried: 1, failed: 0 });
    const rejected = await run(mockPool(), { async send() { throw new MessagingProviderError('bad number', { retryable: false, code: 'sms_http_400' }); } });
    assert.deepEqual(rejected, { claimed: 1, sent: 0, cancelled: 0, retried: 0, failed: 1 });
    const exhausted = await run(mockPool({ job: { ...JOB, Attempts: 6 } }), { async send() { throw new MessagingProviderError('down', { retryable: true, code: 'sms_http_503' }); } });
    assert.equal(exhausted.failed, 1);
  });

  it('a provider refusal because the recipient replied STOP records a standing stop and cancels, instead of retrying', async () => {
    const pool = mockPool();
    const result = await run(pool, { async send() { throw new MessagingProviderError('Recipient has opted out.', { retryable: false, code: 'recipient_opted_out' }); } });
    assert.deepEqual(result, { claimed: 1, sent: 0, cancelled: 1, retried: 0, failed: 0 });
    assert.ok(pool.calls.some((call) => call.sql.startsWith('INSERT INTO "MessagingSuppressions"')));
  });

  it('takes work only for businesses that are active, a batch at a time, with the lease and attempt limits', async () => {
    const pool = mockPool();
    await run(pool, { async send() { return { providerMessageId: 'x' }; } }, { batchLimit: 7, maxAttempts: 4 });
    const pick = pool.calls.find((call) => call.sql.startsWith('WITH picked AS'));
    assert.match(pick.sql, /b\."IsActive"=TRUE/);
    assert.match(pick.sql, /FOR UPDATE OF q SKIP LOCKED/);
    assert.equal(pick.params[2], 7);
    assert.equal(pick.params[3], 4);
  });
});
