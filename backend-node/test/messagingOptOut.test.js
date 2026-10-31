import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUnsubscribeToken, inboundKeyword, maskPhone, messagingSigningSecret, normalizePhone, twilioSignature, unsubscribeUrl, verifyTwilioSignature, verifyUnsubscribeToken } from '../src/messaging/optOut.js';
import { isMessagingSuppressed, liftMessagingSuppression, recordMessagingSuppression } from '../src/messaging/suppressions.js';
import { createConfiguredMessagingProvider, MessagingProviderError } from '../src/messaging/provider.js';

const SECRET = 's'.repeat(40);
const IDS = { businessId: '11111111-1111-4111-8111-111111111111', preferenceId: '22222222-2222-4222-8222-222222222222' };

describe('unsubscribe token', () => {
  it('round-trips the business and preference IDs', () => {
    assert.deepEqual(verifyUnsubscribeToken(SECRET, createUnsubscribeToken(SECRET, IDS)), IDS);
  });
  it('rejects a token signed with another key, an edited payload, and malformed input, all the same way', () => {
    const token = createUnsubscribeToken(SECRET, IDS);
    const [payload, signature] = token.split('.');
    const other = Buffer.from(`${IDS.businessId.replace('1', '3')}.${IDS.preferenceId}`).toString('base64url');
    for (const bad of [createUnsubscribeToken('t'.repeat(40), IDS), `${other}.${signature}`, `${payload}.`, payload, '', `${token}x`, 'a.b.c', 'x'.repeat(500), null, undefined, 42]) {
      assert.equal(verifyUnsubscribeToken(SECRET, bad), null);
    }
  });
  it('is useless without a configured key and refuses to be built from bad IDs', () => {
    assert.equal(verifyUnsubscribeToken(null, createUnsubscribeToken(SECRET, IDS)), null);
    assert.throws(() => createUnsubscribeToken(SECRET, { businessId: 'nope', preferenceId: IDS.preferenceId }), TypeError);
    assert.throws(() => createUnsubscribeToken('', IDS), TypeError);
  });
  it('builds a link with the token in the fragment, never in the path or query', () => {
    const url = unsubscribeUrl({ WEB_BASE_URL: 'https://shop.example.com/' }, SECRET, IDS);
    assert.match(url, /^https:\/\/shop\.example\.com\/unsubscribe#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(unsubscribeUrl({ WEB_BASE_URL: 'https://x' }, null, IDS), null);
  });
  it('takes the signing key from CSRF_SIGNING_KEY, then JWT_SIGNING_KEY, and ignores short keys', () => {
    assert.equal(messagingSigningSecret({ CSRF_SIGNING_KEY: 'c'.repeat(32), JWT_SIGNING_KEY: 'j'.repeat(32) }), 'c'.repeat(32));
    assert.equal(messagingSigningSecret({ JWT_SIGNING_KEY: 'j'.repeat(32) }), 'j'.repeat(32));
    assert.equal(messagingSigningSecret({ JWT_SIGNING_KEY: 'short' }), null);
    assert.equal(messagingSigningSecret({}), null);
  });
});

describe('inbound keywords and phone helpers', () => {
  it('recognises the six STOP words in any case and with spaces, and only when the whole message is the word', () => {
    for (const word of ['STOP', 'stop', ' Stop ', 'STOPALL', 'UNSUBSCRIBE', 'cancel', 'END', 'quit']) assert.equal(inboundKeyword(word), 'stop', word);
    for (const text of ['please stop', 'stop it', 'stopping', '', null, undefined, 'help']) assert.equal(inboundKeyword(text), null, String(text));
  });
  it('recognises START', () => {
    for (const word of ['START', 'start', 'YES', 'UNSTOP']) assert.equal(inboundKeyword(word), 'start', word);
  });
  it('normalises phone numbers like the consent route and refuses non-numbers', () => {
    assert.equal(normalizePhone('+234 801 234 5678'), '+2348012345678');
    assert.equal(normalizePhone('2348012345678'), '+2348012345678');
    for (const bad of ['whatsapp:+2348012345678', 'abc', '', null, '+0123456789', '12']) assert.equal(normalizePhone(bad), null, String(bad));
  });
  it('masks all but the start and end of a number', () => {
    assert.equal(maskPhone('+2348012340000'), '+234****0000');
    assert.equal(maskPhone('+1234'), '****');
  });
});

describe('Twilio request signature', () => {
  // The example from Twilio's request-validation documentation, reproduced from memory: re-check it against the current page.
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' };
  it('reproduces the documented example value', () => {
    assert.equal(twilioSignature('12345', url, params), 'GvWf1cFY/Q7PnoempGyD5oXAezc=');
  });
  it('accepts the right signature and rejects a changed parameter, URL, token, or missing header', () => {
    const header = twilioSignature('12345', url, params);
    assert.equal(verifyTwilioSignature('12345', url, params, header), true);
    assert.equal(verifyTwilioSignature('12345', url, { ...params, Body: 'STOP' }, header), false);
    assert.equal(verifyTwilioSignature('12345', `${url}x`, params, header), false);
    assert.equal(verifyTwilioSignature('other', url, params, header), false);
    assert.equal(verifyTwilioSignature('12345', url, params, undefined), false);
    assert.equal(verifyTwilioSignature('', url, params, header), false);
  });
  it('sorts parameters by name before signing', () => {
    assert.equal(twilioSignature('t', 'https://x', { b: '2', a: '1' }), twilioSignature('t', 'https://x', { a: '1', b: '2' }));
  });
});

describe('suppression store', () => {
  const fake = () => { const calls = []; return { calls, async query(sql, params) { calls.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: sql.startsWith('SELECT') ? [{ x: 1 }] : [], rowCount: 1 }; } }; };
  it('looks a stop up by channel and case-insensitive address, ignoring lifted stops', async () => {
    const db = fake();
    assert.equal(await isMessagingSuppressed(db, { channel: 'SMS', address: '+234' }), true);
    assert.match(db.calls[0].sql, /"LiftedAtUtc" IS NULL/);
    assert.deepEqual(db.calls[0].params, ['SMS', '+234']);
  });
  it('records a stop idempotently and lifts only the standing one', async () => {
    const db = fake();
    await recordMessagingSuppression(db, { channel: 'SMS', address: '+234', source: 'SmsStop' });
    assert.match(db.calls[0].sql, /ON CONFLICT .* DO NOTHING/);
    assert.equal(await liftMessagingSuppression(db, { channel: 'SMS', address: '+234' }), true);
    assert.match(db.calls[1].sql, /^UPDATE "MessagingSuppressions" SET "LiftedAtUtc"/);
    assert.doesNotMatch(db.calls[1].sql, /CustomerMessagingPreferences/);
  });
});

describe('Twilio refusal handling', () => {
  const make = (response) => createConfiguredMessagingProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+10000000000' }, { fetchImpl: async () => response });
  const send = (provider) => provider.send({ channel: 'SMS', to: '+2348000000000', text: 'Hi', idempotencyKey: 'k' });
  it('turns error 21610 into a non-retryable "recipient_opted_out"', async () => {
    await assert.rejects(() => send(make({ ok: false, status: 400, json: async () => ({ code: 21610, message: 'blocked' }) })), (error) => error instanceof MessagingProviderError && error.code === 'recipient_opted_out' && error.retryable === false);
  });
  it('keeps other refusals as before, retrying only 429 and 5xx', async () => {
    await assert.rejects(() => send(make({ ok: false, status: 400, json: async () => ({ code: 21211 }) })), (error) => error.code === 'sms_http_400' && error.retryable === false);
    await assert.rejects(() => send(make({ ok: false, status: 503, json: async () => { throw new Error('not json'); } })), (error) => error.code === 'sms_http_503' && error.retryable === true);
  });
});
