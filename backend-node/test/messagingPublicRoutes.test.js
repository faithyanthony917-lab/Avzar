import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { createHmac } from 'node:crypto';
import { createUnsubscribeToken, maskPhone, twilioSignature } from '../src/messaging/optOut.js';

const KEY = 'test-signing-key-with-at-least-thirty-two-characters';
const AUTH_TOKEN = 'twilio-test-auth-token';
const WEBHOOK = 'https://api.example.test/api/messaging/twilio/inbound';
const env = { NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent', JWT_SIGNING_KEY: KEY, JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10, TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_BASE_URL: 'https://api.example.test' };
const BIZ = '00000000-0000-4000-8000-0000000000b1';
const PREF = '00000000-0000-4000-8000-0000000000c1';
const ADDRESS = '+2348012345678';
const token = (b = BIZ, p = PREF) => createUnsubscribeToken(KEY, { businessId: b, preferenceId: p });

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body, text, type: response.headers.get('content-type') };
  } finally { await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))); }
}
function fakePool({ known = true, status = 'OptedIn' } = {}) {
  const calls = [];
  return { calls, async query(sql, values = []) {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    if (sql.includes('SELECT p."Channel"')) return { rows: known && values[0] === PREF && values[1] === BIZ ? [{ Channel: 'SMS', Address: ADDRESS, ConsentStatus: status, BusinessName: 'Ada Tailors' }] : [] };
    if (sql.includes('UPDATE "CustomerMessagingPreferences"')) return { rows: known && values[0] === PREF && values[1] === BIZ ? [{ Channel: 'SMS', Address: ADDRESS, BusinessName: 'Ada Tailors' }] : [] };
    return { rows: [], rowCount: 1 };
  } };
}
const postJson = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const form = (fields, signature) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature === undefined ? {} : { 'x-twilio-signature': signature }) }, body: new URLSearchParams(fields).toString() });

describe('unsubscribe routes', () => {
  it('previews a genuine link with a masked number and changes nothing; no CSRF token needed', async () => {
    const pool = fakePool();
    const res = await requestApp(createApp(env, pool), '/api/messaging/unsubscribe/preview', postJson({ token: token() }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { businessName: 'Ada Tailors', channel: 'SMS', maskedAddress: maskPhone(ADDRESS), alreadyOptedOut: false });
    assert.ok(pool.calls.every((call) => !call.sql.startsWith('UPDATE')));
  });
  it('confirms an opt-out with the reserved customer_link source, scoped by business', async () => {
    const pool = fakePool();
    const res = await requestApp(createApp(env, pool), '/api/messaging/unsubscribe/confirm', postJson({ token: token() }));
    assert.equal(res.status, 200);
    assert.equal(res.body.optedOut, true);
    const update = pool.calls.find((call) => call.sql.startsWith('UPDATE "CustomerMessagingPreferences"'));
    assert.deepEqual(update.values, [PREF, BIZ, 'customer_link']);
    assert.match(update.sql, /p\."BusinessId" = \$2/);
  });
  it('gives forged, malformed, missing and unknown tokens the same 404, and a forged one never reaches the database', async () => {
    const forgedPool = fakePool();
    const forged = await requestApp(createApp(env, forgedPool), '/api/messaging/unsubscribe/confirm', postJson({ token: `${token().split('.')[0]}.AAAAAAAA` }));
    const malformed = await requestApp(createApp(env, fakePool()), '/api/messaging/unsubscribe/preview', postJson({ token: 'not a token' }));
    const missing = await requestApp(createApp(env, fakePool()), '/api/messaging/unsubscribe/preview', postJson({}));
    const unknown = await requestApp(createApp(env, fakePool({ known: false })), '/api/messaging/unsubscribe/confirm', postJson({ token: token() }));
    for (const res of [forged, malformed, missing, unknown]) { assert.equal(res.status, 404); assert.equal(res.body.code, 'unsubscribe_link_invalid'); }
    assert.equal(forgedPool.calls.length, 0);
  });
});

describe('Twilio inbound route', () => {
  const stopFields = { From: ADDRESS, Body: 'STOP' };
  it('records a stop for a correctly signed STOP and answers with an empty TwiML reply', async () => {
    const pool = fakePool();
    const res = await requestApp(createApp(env, pool), '/api/messaging/twilio/inbound', form(stopFields, twilioSignature(AUTH_TOKEN, WEBHOOK, stopFields)));
    assert.equal(res.status, 200);
    assert.match(res.type, /xml/);
    assert.match(res.text, /<Response><\/Response>/);
    const insert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO "MessagingSuppressions"'));
    assert.deepEqual(insert.values.slice(1), ['SMS', ADDRESS, 'SmsStop']);
  });
  it('lifts the stop on START and does not touch any consent record', async () => {
    const pool = fakePool(); const fields = { From: ADDRESS, Body: 'start' };
    const res = await requestApp(createApp(env, pool), '/api/messaging/twilio/inbound', form(fields, twilioSignature(AUTH_TOKEN, WEBHOOK, fields)));
    assert.equal(res.status, 200);
    assert.ok(pool.calls.some((call) => call.sql.startsWith('UPDATE "MessagingSuppressions" SET "LiftedAtUtc"')));
    assert.ok(pool.calls.every((call) => !call.sql.includes('CustomerMessagingPreferences')));
  });
  it('does nothing for ordinary text', async () => {
    const pool = fakePool(); const fields = { From: ADDRESS, Body: 'Can I move my fitting?' };
    const res = await requestApp(createApp(env, pool), '/api/messaging/twilio/inbound', form(fields, twilioSignature(AUTH_TOKEN, WEBHOOK, fields)));
    assert.equal(res.status, 200);
    assert.equal(pool.calls.length, 0);
  });
  it('rejects a missing, wrong or other-URL signature with 403 and records nothing', async () => {
    for (const signature of [undefined, 'bad', twilioSignature('other-token', WEBHOOK, stopFields), twilioSignature(AUTH_TOKEN, 'https://evil.example/api/messaging/twilio/inbound', stopFields)]) {
      const pool = fakePool();
      const res = await requestApp(createApp(env, pool), '/api/messaging/twilio/inbound', form(stopFields, signature));
      assert.equal(res.status, 403); assert.equal(pool.calls.length, 0);
    }
  });
  it('answers 503 when Twilio is not configured', async () => {
    const res = await requestApp(createApp({ ...env, TWILIO_AUTH_TOKEN: '' }, fakePool()), '/api/messaging/twilio/inbound', form(stopFields, 'x'));
    assert.equal(res.status, 503);
  });
});

// ---- Step 16d: Meta's WhatsApp webhook
describe('WhatsApp webhook route', () => {
  const APP_SECRET = 'meta-app-secret-for-tests';
  const VERIFY = 'meta-verify-token';
  const waEnv = { ...env, META_WHATSAPP_APP_SECRET: APP_SECRET, META_WHATSAPP_VERIFY_TOKEN: VERIFY, META_WHATSAPP_PHONE_NUMBER_ID: '1001' };
  const PATH = '/api/messaging/whatsapp/webhook';
  const message = (from, body) => ({ from, id: 'wamid.1', type: 'text', text: { body } });
  const bodyOf = (messages, phoneNumberId = '1001') => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, messages } }] }] });
  const signed = (raw, secret = APP_SECRET) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
  const WA = '2348012345678';

  it('answers the verify handshake with the challenge only for the right token, and refuses anything else', async () => {
    const ok = await requestApp(createApp(waEnv, fakePool()), `${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    assert.equal(ok.status, 200); assert.equal(ok.text, '1158201444'); assert.match(ok.type, /text\/plain/);
    for (const query of [`hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`, `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`, `hub.mode=subscribe&hub.challenge=1`]) {
      assert.equal((await requestApp(createApp(waEnv, fakePool()), `${PATH}?${query}`)).status, 403, query);
    }
    assert.equal((await requestApp(createApp(waEnv, fakePool()), `${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`)).status, 400);
    assert.equal((await requestApp(createApp({ ...waEnv, META_WHATSAPP_VERIFY_TOKEN: '' }, fakePool()), `${PATH}?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`)).status, 503);
  });

  it('records a sender-wide WhatsApp stop for a correctly signed STOP; no CSRF token needed', async () => {
    const pool = fakePool();
    const res = await requestApp(createApp(waEnv, pool), PATH, signed(bodyOf([message(WA, 'STOP')])));
    assert.equal(res.status, 200); assert.deepEqual(res.body, { received: true });
    const insert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO "MessagingSuppressions"'));
    assert.deepEqual(insert.values.slice(1), ['WhatsApp', `+${WA}`, 'WhatsAppStop']);
    assert.ok(pool.calls.every((call) => !call.sql.includes('CustomerMessagingPreferences')), 'no business consent is touched');
  });

  it('lifts only the stop on START, and does nothing for ordinary text, statuses or another number', async () => {
    const start = fakePool();
    assert.equal((await requestApp(createApp(waEnv, start), PATH, signed(bodyOf([message(WA, 'Start')])))).status, 200);
    assert.ok(start.calls.some((call) => call.sql.startsWith('UPDATE "MessagingSuppressions" SET "LiftedAtUtc"')));
    assert.ok(start.calls.every((call) => !call.sql.includes('CustomerMessagingPreferences')));
    for (const raw of [bodyOf([message(WA, 'Can I move my fitting?')]), bodyOf([message(WA, 'STOP')], '9999'), JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] }), '{}']) {
      const pool = fakePool();
      assert.equal((await requestApp(createApp(waEnv, pool), PATH, signed(raw))).status, 200);
      assert.equal(pool.calls.length, 0, raw.slice(0, 60));
    }
  });

  it('rejects a missing, wrong-secret or altered-body signature with 403 and records nothing', async () => {
    const raw = bodyOf([message(WA, 'STOP')]);
    const wrong = signed(raw, 'other-secret');
    const altered = { ...signed(raw), body: bodyOf([message('2348099999999', 'STOP')]) };
    const missing = { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw };
    for (const init of [wrong, altered, missing]) {
      const pool = fakePool();
      const res = await requestApp(createApp(waEnv, pool), PATH, init);
      assert.equal(res.status, 403); assert.equal(res.body.code, 'invalid_signature'); assert.equal(pool.calls.length, 0);
    }
  });

  it('answers 503 when the app secret is not configured', async () => {
    const raw = bodyOf([message(WA, 'STOP')]);
    assert.equal((await requestApp(createApp({ ...waEnv, META_WHATSAPP_APP_SECRET: '' }, fakePool()), PATH, signed(raw))).status, 503);
  });
});
