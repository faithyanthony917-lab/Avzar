import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCustomerMessagesOnce } from '../src/messaging/customerMessageWorker.js';
import { verifyUnsubscribeToken } from '../src/messaging/optOut.js';
import { MessagingProviderError } from '../src/messaging/provider.js';

const PREFERENCE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENV = { JWT_SIGNING_KEY: 'k'.repeat(40), WEB_BASE_URL: 'https://app.example.com/' };
const NOW = new Date('2026-10-21T12:00:00.000Z');
const JOB = {
  Id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  BusinessId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  AppointmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  CustomerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  Channel: 'SMS',
  Address: '+2348000000000',
  AppointmentStartUtc: new Date('2026-10-22T12:00:00.000Z'),
  OffsetMinutes: 1440,
  LeaseUntilUtc: new Date(NOW.getTime() + 60_000),
  Attempts: 1,
};

function mockPool({ consent = true, suppressed = false, template = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT "Body" FROM "NotificationTemplates"')) return { rows: template && params[2] === template.channel ? [{ Body: template.body }] : [], rowCount: template ? 1 : 0 };
      if (normalized.startsWith('UPDATE "CustomerMessageOutbox" SET "Status"=\'Failed\'')) return { rows: [], rowCount: 0 };
      if (normalized.startsWith('WITH picked AS')) return { rows: [{ ...JOB, LeaseUntilUtc: params[1] }], rowCount: 1 };
      if (normalized.startsWith('SELECT a."Status"')) return { rows: [{ Status: 'Scheduled', StartUtc: JOB.AppointmentStartUtc, Type: 'Fitting', TimeZoneId: 'UTC', FullName: 'Customer', BusinessName: 'Avzar Shop' }], rowCount: 1 };
      if (normalized.startsWith('SELECT 1 FROM "MessagingSuppressions"')) return { rows: suppressed ? [{ '?column?': 1 }] : [], rowCount: suppressed ? 1 : 0 };
      if (normalized.startsWith('SELECT "Id" FROM "CustomerMessagingPreferences"')) return { rows: [{ Id: PREFERENCE_ID }], rowCount: 1 };
      if (normalized.startsWith('INSERT INTO "MessagingSuppressions"')) return { rows: [], rowCount: 1 };
      if (normalized.startsWith('SELECT 1 FROM "CustomerMessagingPreferences"')) return { rows: consent ? [{ '?column?': 1 }] : [], rowCount: consent ? 1 : 0 };
      if (normalized.startsWith('UPDATE "CustomerMessageOutbox" SET "Status"=\'Sent\'')) return { rows: [], rowCount: 1 };
      if (normalized.startsWith('UPDATE "CustomerMessageOutbox" SET "Status"=\'Cancelled\'')) return { rows: [], rowCount: 1 };
      if (normalized.startsWith('UPDATE "CustomerMessageOutbox" SET "Status"=$3')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test mock: ${normalized.slice(0, 100)}`);
    },
  };
}

describe('durable customer appointment reminder worker', () => {
  it('sends only after checking current appointment state and explicit consent', async () => {
    const pool = mockPool({ consent: true });
    const sent = [];
    const result = await dispatchCustomerMessagesOnce(pool, {
      now: NOW,
      provider: { async send(message) { sent.push(message); return { providerMessageId: 'provider-123' }; } },
      log: { error() {} },
    });
    assert.deepEqual(result, { claimed: 1, sent: 1, cancelled: 0, retried: 0, failed: 0 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].idempotencyKey, `avzar-appointment-${JOB.Id}`);
    assert.ok(pool.calls.some((call) => call.sql.startsWith('SELECT 1 FROM "CustomerMessagingPreferences"')));
    assert.ok(pool.calls.some((call) => call.sql.includes('"Status"=\'Sent\'')));
  });

  it('cancels an already queued message when consent has been withdrawn', async () => {
    const pool = mockPool({ consent: false });
    let sendCalls = 0;
    const result = await dispatchCustomerMessagesOnce(pool, {
      now: NOW,
      provider: { async send() { sendCalls++; return { providerMessageId: 'unexpected' }; } },
      log: { error() {} },
    });
    assert.deepEqual(result, { claimed: 1, sent: 0, cancelled: 1, retried: 0, failed: 0 });
    assert.equal(sendCalls, 0);
    assert.ok(pool.calls.some((call) => call.sql.includes('"Status"=\'Cancelled\'')));
  });
});

describe('opt-out wording, links and stops', () => {
  const run = (pool, provider, extra = {}) => dispatchCustomerMessagesOnce(pool, { now: NOW, provider, env: ENV, log: { error() {} }, ...extra });

  it('step 16c: sends the business\'s saved reminder wording for the channel, filled from the appointment as it is now, with the opt-out line after it', async () => {
    const pool = mockPool({ template: { channel: 'SMS', body: 'See you {timing} for your {type}! ({when}) - {business}' } });
    const sent = [];
    await run(pool, { async send(message) { sent.push(message); return { providerMessageId: 'p' }; } });
    assert.match(sent[0].text, /^See you tomorrow for your fitting! \(.+\) - Avzar Shop Reply STOP to opt out\. Unsubscribe: /);
    assert.deepEqual(pool.calls.find((call) => call.sql.includes('"NotificationTemplates"')).params.slice(1), ['appointment.reminder', 'SMS']);
  });

  it('adds "Reply STOP" and a signed unsubscribe link to an SMS reminder', async () => {
    const sent = [];
    const result = await run(mockPool(), { async send(message) { sent.push(message); return { providerMessageId: 'p1' }; } });
    assert.equal(result.sent, 1);
    assert.match(sent[0].text, /Reply STOP to opt out\. Unsubscribe: https:\/\/app\.example\.com\/unsubscribe#/);
    const token = sent[0].text.split('/unsubscribe#')[1];
    assert.deepEqual(verifyUnsubscribeToken(ENV.JWT_SIGNING_KEY, token), { businessId: JOB.BusinessId, preferenceId: PREFERENCE_ID });
  });

  it('gives a WhatsApp reminder the link only, with no STOP instruction', async () => {
    const sent = [];
    const pool = mockPool();
    const original = pool.query;
    pool.query = async (sql, params) => { const r = await original(sql, params); return sql.replace(/\s+/g, ' ').trim().startsWith('WITH picked AS') ? { ...r, rows: [{ ...r.rows[0], Channel: 'WhatsApp' }] } : r; };
    await run(pool, { async send(message) { sent.push(message); return { providerMessageId: 'p2' }; } });
    assert.match(sent[0].text, /Unsubscribe: https:\/\/app\.example\.com\/unsubscribe#/);
    assert.doesNotMatch(sent[0].text, /Reply STOP/);
    // Step 16d: and WhatsApp starts the conversation with the Meta-approved reminder template.
    assert.equal(sent[0].template.name, 'avzar_appointment_reminder');
    assert.equal(sent[0].template.language, 'en');
    assert.equal(sent[0].template.parameters.length, 5);
    assert.deepEqual(sent[0].template.parameters.slice(0, 3), ['Avzar Shop', 'fitting', 'tomorrow']);
    assert.match(sent[0].template.parameters[4], /^https:\/\/app\.example\.com\/unsubscribe#/);
  });

  it('leaves the link out, but keeps "Reply STOP", when no signing key is configured', async () => {
    const sent = [];
    await dispatchCustomerMessagesOnce(mockPool(), { now: NOW, env: {}, provider: { async send(message) { sent.push(message); return { providerMessageId: 'p3' }; } }, log: { error() {} } });
    assert.match(sent[0].text, /Reply STOP to opt out\.$/);
    assert.doesNotMatch(sent[0].text, /unsubscribe/i);
  });

  it('does not send to an address under a standing sender-wide stop, even with a current OptedIn record', async () => {
    let sends = 0;
    const result = await run(mockPool({ consent: true, suppressed: true }), { async send() { sends++; return { providerMessageId: 'x' }; } });
    assert.equal(sends, 0);
    assert.equal(result.cancelled, 1);
  });

  it('records a Twilio 21610 refusal as a stop, cancels the message and does not retry', async () => {
    const pool = mockPool();
    const result = await run(pool, { async send() { throw new MessagingProviderError('Recipient has opted out.', { retryable: false, code: 'recipient_opted_out' }); } });
    assert.deepEqual(result, { claimed: 1, sent: 0, cancelled: 1, retried: 0, failed: 0 });
    const insert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO "MessagingSuppressions"'));
    assert.ok(insert);
    assert.deepEqual(insert.params.slice(1), ['SMS', JOB.Address, 'ProviderRefusal']);
  });
});
