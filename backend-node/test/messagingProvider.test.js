import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessagingProvider, customerMessagingConsent, MessagingProviderError } from '../src/messaging/provider.js';

test('messaging provider validates required fields and configured channel', async () => {
  const provider = createMessagingProvider();
  await assert.rejects(provider.send({ channel: 'SMS', to: '+2348000000000', text: 'Reminder', idempotencyKey: 'reminder-1' }),
    (error) => error instanceof MessagingProviderError && error.code === 'provider_not_configured');
  await assert.rejects(provider.send({ channel: 'email', to: 'x', text: 'y', idempotencyKey: 'z' }), TypeError);
});

test('messaging provider returns normalized accepted response and hides raw vendor errors', async () => {
  const provider = createMessagingProvider({ sendSms: async ({ to, idempotencyKey }) => ({ providerMessageId: `${to}:${idempotencyKey}` }) });
  const result = await provider.send({ channel: 'SMS', to: ' +2348000000000 ', text: 'Reminder', idempotencyKey: 'reminder-2' });
  assert.equal(result.channel, 'SMS');
  assert.equal(result.providerMessageId, '+2348000000000:reminder-2');
  assert.ok(Number.isFinite(Date.parse(result.acceptedAtUtc)));
  const broken = createMessagingProvider({ sendSms: async () => { throw new Error('secret vendor payload'); } });
  await assert.rejects(broken.send({ channel: 'SMS', to: '123', text: 'x', idempotencyKey: 'k' }), (error) => {
    assert.equal(error.code, 'provider_request_failed');
    assert.equal(error.message.includes('secret vendor payload'), false);
    return true;
  });
});

test('customer messaging consent fails closed and scopes all identifying fields', async () => {
  let query;
  const db = { query: async (...args) => { query = args; return { rows: [] }; } };
  assert.equal(await customerMessagingConsent(db, { businessId: 'b', customerId: 'c', channel: 'SMS', address: '+234' }), false);
  assert.match(query[0], /"BusinessId" = \$1 AND "CustomerId" = \$2 AND "Channel" = \$3/);
  assert.match(query[0], /"ConsentStatus" = 'OptedIn'/);
  assert.equal(await customerMessagingConsent(db, { businessId: 'b', customerId: 'c', channel: 'Email', address: 'a' }), false);
});

test('configured provider sends SMS through Twilio and normalizes its message ID', async () => {
  const { createConfiguredMessagingProvider } = await import('../src/messaging/provider.js');
  let request;
  const provider = createConfiguredMessagingProvider({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_SMS_FROM: '+10000000000' }, {
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 201, json: async () => ({ sid: 'SM123' }) }; },
  });
  const result = await provider.send({ channel: 'SMS', to: '+10000000001', text: 'Reminder', idempotencyKey: 'reminder-123' });
  assert.equal(result.providerMessageId, 'SM123');
  assert.match(request.url, /Accounts%2FAC123|Accounts\/AC123/);
  assert.equal(request.options.method, 'POST');
  assert.match(request.options.headers.Authorization, /^Basic /);
});

test('configured provider sends WhatsApp through Meta and rejects unconfigured channels safely', async () => {
  const { createConfiguredMessagingProvider, MessagingProviderError } = await import('../src/messaging/provider.js');
  const provider = createConfiguredMessagingProvider({ META_WHATSAPP_ACCESS_TOKEN: 'secret', META_WHATSAPP_PHONE_NUMBER_ID: '12345', META_GRAPH_API_VERSION: 'v23.0' }, {
    fetchImpl: async (_url, options) => { assert.equal(options.method, 'POST'); const body = JSON.parse(options.body); assert.equal(body.to, '2348000000000'); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.123' }] }) }; },
  });
  const result = await provider.send({ channel: 'WhatsApp', to: '+2348000000000', text: 'Reminder', idempotencyKey: 'reminder-456' });
  assert.equal(result.providerMessageId, 'wamid.123');
  await assert.rejects(() => provider.send({ channel: 'SMS', to: '+10000000001', text: 'Reminder', idempotencyKey: 'reminder-789' }), MessagingProviderError);
});

test('customer message send refuses unknown/opted-out recipients before calling provider', async () => {
  const { sendCustomerMessage } = await import('../src/messaging/provider.js');
  let sends = 0;
  const provider = { send: async () => { sends += 1; return { providerMessageId: 'm1' }; } };
  const db = { query: async () => ({ rows: [] }) };
  const result = await sendCustomerMessage(db, provider, { businessId: 'b', customerId: 'c', channel: 'SMS', address: '+234', to: '+234', text: 'Reminder', idempotencyKey: 'r-1' });
  assert.deepEqual(result, { sent: false, reason: 'consent_required' });
  assert.equal(sends, 0);
});

// ---- Step 16d: WhatsApp templates and Meta failures
import { buildWhatsAppPayload, createConfiguredMessagingProvider, whatsappFailure } from '../src/messaging/provider.js';

const META_ENV = { META_WHATSAPP_ACCESS_TOKEN: 'meta-token', META_WHATSAPP_PHONE_NUMBER_ID: '1001', META_GRAPH_API_VERSION: 'v23.0' };
const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

test('step 16d: a WhatsApp template is sent as a template message with body variables; without one it is plain text', () => {
  const withTemplate = buildWhatsAppPayload({ to: '+2348000000000', text: 'ignored', template: { name: 'avzar_order_ready', language: 'en', parameters: ['B', 'O-1', 'Ready.', 'https://x.example/u#t'] } });
  assert.deepEqual(withTemplate, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '2348000000000', type: 'template',
    template: { name: 'avzar_order_ready', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'B' }, { type: 'text', text: 'O-1' }, { type: 'text', text: 'Ready.' }, { type: 'text', text: 'https://x.example/u#t' }] }] },
  });
  assert.deepEqual(buildWhatsAppPayload({ to: '+2348000000000', text: 'Hello' }), { messaging_product: 'whatsapp', recipient_type: 'individual', to: '2348000000000', type: 'text', text: { preview_url: false, body: 'Hello' } });
});

test('step 16d: the configured provider posts the template to the Graph API and returns the message id', async () => {
  const calls = [];
  const provider = createConfiguredMessagingProvider(META_ENV, { fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(200, { messages: [{ id: 'wamid.ABC' }] }); } });
  const result = await provider.send({ channel: 'WhatsApp', to: '+2348000000000', text: 'x', idempotencyKey: 'k1', template: { name: 'avzar_order_ready', language: 'en', parameters: ['a'] } });
  assert.equal(result.providerMessageId, 'wamid.ABC');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/1001/messages');
  assert.equal(JSON.parse(calls[0].init.body).type, 'template');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer meta-token');
  await provider.send({ channel: 'SMS', to: '+2348000000000', text: 'x', idempotencyKey: 'k2', template: { name: 'ignored' } }).catch((error) => assert.equal(error.code, 'provider_not_configured'));
});

test('step 16d: Meta failures keep only a numeric code; an opted-out person is a refusal; template and window errors are not retried', async () => {
  assert.deepEqual([whatsappFailure(400, { error: { code: 131050, message: 'secret text' } }).code, whatsappFailure(400, { error: { code: 131050 } }).retryable], ['recipient_opted_out', false]);
  const template = whatsappFailure(400, { error: { code: 132001, message: 'Template name does not exist' } });
  assert.deepEqual([template.code, template.retryable, template.message.includes('Template name')], ['whatsapp_meta_132001', false, false]);
  assert.equal(whatsappFailure(400, { error: { code: 131047 } }).retryable, false);
  assert.equal(whatsappFailure(400, { error: { code: 131056 } }).retryable, true);
  assert.equal(whatsappFailure(500, { error: { code: 1 } }).retryable, true);
  assert.deepEqual([whatsappFailure(429, null).code, whatsappFailure(429, null).retryable], ['whatsapp_http_429', true]);
  assert.deepEqual([whatsappFailure(400, 'not json').code, whatsappFailure(400, undefined).retryable], ['whatsapp_http_400', false]);
  const provider = createConfiguredMessagingProvider(META_ENV, { fetchImpl: async () => reply(400, { error: { code: 131050 } }) });
  await assert.rejects(provider.send({ channel: 'WhatsApp', to: '+2348000000000', text: 'x', idempotencyKey: 'k3' }), (error) => error.code === 'recipient_opted_out');
});
