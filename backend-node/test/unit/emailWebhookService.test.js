import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleResendWebhook } from '../../src/email/webhookService.js';
import { parseSecret, sign } from '../../src/email/svix.js';

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const key = parseSecret(secret);
const now = Date.now();

function signed(body, { eventId = 'evt_123', secretValue = secret, nowMs = now } = {}) {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    pool: null, secret: secretValue, id: eventId, timestamp,
    signature: `v1,${sign(parseSecret(secretValue), eventId, timestamp, body)}`,
    body, now: nowMs,
  };
}

function fakePool(responses = []) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    },
  };
}

describe('Resend webhook service', () => {
  it('rejects disabled configuration and invalid signatures before database access', async () => {
    const pool = fakePool();
    const event = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1' } });
    assert.equal(await handleResendWebhook({ ...signed(event), pool, secret: '' }), 'disabled');
    assert.equal(await handleResendWebhook({ ...signed(event, { secretValue: secret }), pool, signature: 'v1,invalid' }), 'invalid_signature');
    assert.equal(pool.calls.length, 0);
  });

  it('records a permanent bounce and inserts a global suppression from the outbox address', async () => {
    const pool = fakePool([{ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }]);
    const body = '{ "type":"email.bounced", "data":{"email_id":"em_1","bounce":{"type":"Permanent","message":"Mailbox gone\\nDetails"}} }';
    assert.equal(await handleResendWebhook({ ...signed(body), pool }), 'applied');
    assert.match(pool.calls[0].sql, /lower\(btrim\("ToAddress"\)\)/);
    assert.deepEqual(pool.calls[0].values, ['em_1', 'Bounced']);
    assert.deepEqual(pool.calls[1].values, ['em_1', 'Bounced', now, 'Mailbox goneDetails', ['Delayed', 'Delivered']]);
  });

  it('does not suppress transient bounces and never downgrades a more advanced status', async () => {
    const pool = fakePool([{ rows: [], rowCount: 1 }]);
    const body = JSON.stringify({ type: 'email.delivery_delayed', data: { email_id: 'em_2' } });
    assert.equal(await handleResendWebhook({ ...signed(body), pool }), 'applied');
    assert.equal(pool.calls.length, 1);
    assert.deepEqual(pool.calls[0].values[4], []);
  });

  it('acknowledges malformed, unsupported, duplicate, and unknown events safely', async () => {
    const invalidJson = '{';
    assert.equal(await handleResendWebhook({ ...signed(invalidJson), pool: fakePool() }), 'ignored');
    const unsupportedPool = fakePool();
    const unsupported = JSON.stringify({ type: 'email.opened', data: { email_id: 'em_3' } });
    assert.equal(await handleResendWebhook({ ...signed(unsupported), pool: unsupportedPool }), 'ignored');
    assert.equal(unsupportedPool.calls.length, 0);

    const duplicatePool = fakePool([{ rows: [], rowCount: 0 }, { rows: [{ '?column?': 1 }] }]);
    const duplicate = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_4' } });
    assert.equal(await handleResendWebhook({ ...signed(duplicate), pool: duplicatePool }), 'no_change');

    const unknownPool = fakePool([{ rows: [], rowCount: 0 }, { rows: [] }]);
    assert.equal(await handleResendWebhook({ ...signed(duplicate), pool: unknownPool }), 'unknown_message');
  });
});