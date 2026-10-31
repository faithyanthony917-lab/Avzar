import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailTransport, createLogTransport, createResendTransport, createSmtpTransport } from '../../src/email/transports.js';

const options = {
  provider: 'resend', fromAddress: 'noreply@example.com', fromName: 'Avzar "Tailor"\r\nBcc: x@y.z',
  smtp: { host: 'smtp.example.com', port: 587, startTls: true, username: 'user', password: 'secret' },
  resend: { apiKey: 're_key', baseUrl: 'https://api.resend.com/', webhookSecret: '' },
};
const email = { messageId: '11111111-2222-3333-4444-555555555555', to: 'ada@example.com', subject: 'Hello', textBody: 'Hi Ada', htmlBody: '<p>Hi Ada</p>' };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError('no body'); return body; } });

describe('log transport', () => {
  it('reports success with the id "log" and writes one line', async () => {
    const lines = [];
    const result = await createLogTransport({ log: (l) => lines.push(l) }).send(email);
    assert.deepEqual(result, { success: true, transient: false, providerMessageId: 'log', error: null });
    assert.equal(lines.length, 1);
  });
});

describe('resend transport', () => {
  it('posts the message with bearer auth and an idempotency key, and returns the provider id', async () => {
    let seen;
    const transport = createResendTransport({ options, fetchImpl: async (url, init) => { seen = { url, init }; return response(200, { id: 'em_123' }); } });
    const result = await transport.send(email);
    assert.equal(result.success, true);
    assert.equal(result.providerMessageId, 'em_123');
    assert.equal(seen.url, 'https://api.resend.com/emails');
    assert.equal(seen.init.headers.authorization, 'Bearer re_key');
    assert.equal(seen.init.headers['idempotency-key'], '11111111222233334444555555555555');
    const payload = JSON.parse(seen.init.body);
    assert.deepEqual(payload.to, ['ada@example.com']);
    assert.equal(payload.html, '<p>Hi Ada</p>');
    assert.ok(!/[\r\n"]/.test(payload.from.replace(/<.*>$/, '')), 'display name is sanitised');
    assert.match(payload.from, /<noreply@example\.com>$/);
  });
  it('treats an unreadable success body as accepted without an id', async () => {
    const result = await createResendTransport({ options, fetchImpl: async () => response(200) }).send(email);
    assert.deepEqual([result.success, result.providerMessageId], [true, null]);
  });
  it('retries 408, 409, 429 and 5xx; rejects other 4xx', async () => {
    for (const status of [408, 409, 429, 500, 503]) {
      const r = await createResendTransport({ options, fetchImpl: async () => response(status) }).send(email);
      assert.deepEqual([r.success, r.transient], [false, true], String(status));
    }
    for (const status of [400, 401, 403, 404, 422]) {
      const r = await createResendTransport({ options, fetchImpl: async () => response(status) }).send(email);
      assert.deepEqual([r.success, r.transient], [false, false], String(status));
    }
  });
  it('retries network failures and timeouts without throwing', async () => {
    const r = await createResendTransport({ options, fetchImpl: async () => { throw new TypeError('fetch failed'); } }).send(email);
    assert.deepEqual([r.success, r.transient], [false, true]);
  });
});

describe('smtp transport', () => {
  const fake = (behaviour) => {
    const calls = { create: [], send: [] };
    const nodemailer = { createTransport: (o) => { calls.create.push(o); return { sendMail: async (m) => { calls.send.push(m); return behaviour(m); } }; } };
    return { calls, loadNodemailer: async () => ({ default: nodemailer }) };
  };
  it('sends with STARTTLS required and the message id header', async () => {
    const { calls, loadNodemailer } = fake(() => ({}));
    const result = await createSmtpTransport({ options: { ...options, provider: 'smtp' }, loadNodemailer }).send(email);
    assert.equal(result.success, true);
    assert.equal(calls.create[0].requireTLS, true);
    assert.equal(calls.create[0].secure, false);
    assert.deepEqual(calls.create[0].auth, { user: 'user', pass: 'secret' });
    assert.equal(calls.send[0].headers['X-Avzar-Message-Id'], email.messageId);
    assert.equal(calls.send[0].to, 'ada@example.com');
  });
  it('uses implicit TLS on port 465 and no auth without a username', async () => {
    const { calls, loadNodemailer } = fake(() => ({}));
    const opts = { ...options, smtp: { ...options.smtp, port: 465, username: '', password: '' } };
    await createSmtpTransport({ options: opts, loadNodemailer }).send(email);
    assert.equal(calls.create[0].secure, true);
    assert.equal(calls.create[0].auth, undefined);
  });
  it('classifies SMTP failures: 4xx and connection problems retry, 5xx and bad addresses reject', async () => {
    const outcome = async (error) => createSmtpTransport({ options, ...fake(() => { throw Object.assign(new Error('x'), error); }) }).send(email);
    for (const e of [{ responseCode: 451 }, { code: 'ETIMEDOUT' }, { code: 'ECONNECTION' }, { code: 'EAUTH' }, {}]) {
      const r = await outcome(e);
      assert.deepEqual([r.success, r.transient], [false, true], JSON.stringify(e));
    }
    for (const e of [{ responseCode: 550 }, { responseCode: 553 }, { code: 'EENVELOPE' }]) {
      const r = await outcome(e);
      assert.deepEqual([r.success, r.transient], [false, false], JSON.stringify(e));
    }
  });
  it('fails fast in ready() and retries in send() when nodemailer is missing', async () => {
    const transport = createSmtpTransport({ options, loadNodemailer: async () => { throw new Error('Cannot find package'); } });
    await assert.rejects(() => transport.ready(), /npm install nodemailer/);
    const r = await transport.send(email);
    assert.deepEqual([r.success, r.transient], [false, true]);
  });
});

describe('createEmailTransport', () => {
  it('picks the transport by provider and rejects unknown ones', () => {
    assert.equal(createEmailTransport({ ...options, provider: 'log' }).name, 'log');
    assert.equal(createEmailTransport({ ...options, provider: 'resend' }).name, 'resend');
    assert.equal(createEmailTransport({ ...options, provider: 'smtp' }).name, 'smtp');
    assert.throws(() => createEmailTransport({ ...options, provider: 'carrier-pigeon' }), /not supported/);
  });
});
