process.env.NODE_ENV = 'test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

// Step 16c: the message-template routes over HTTP with a pool that answers the exact statements the routes send. Covers permission,
// validation, the preview, reset and the audit entries. Isolation under a restricted role is in test/db/messageTemplates.integration.test.js.

const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};
const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const BASE = '/api/business/message-templates';

const token = () => issueAccessToken({
  jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
}, { userId, businessId, sessionId: '00000000-0000-4000-8000-000000000003' }).token;

async function call(app, method, pathname, body) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function makePool(permissions, saved = []) {
  const state = { saved: [...saved], audits: [], upserts: [], deletes: [] };
  const membership = {
    UserId: userId, Email: 'owner@example.test', FullName: 'Owner', BusinessId: businessId, BusinessName: 'Taratara Atelier', TimeZoneId: 'Africa/Lagos',
    CurrencyCode: 'NGN', IsOwner: false, Permissions: [...permissions, 'locations.all'],
  };
  const handle = async (sql, params = []) => {
    const text = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
    if (text.includes('set_config')) return { rows: [] };
    if (text.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (text.includes('JOIN "AspNetUsers"')) return { rows: [membership] };
    if (text.includes('SELECT "Kind","Channel","Body","UpdatedAtUtc" FROM "NotificationTemplates"')) return { rows: state.saved };
    if (text.includes('INSERT INTO "NotificationTemplates"')) {
      state.upserts.push(params);
      return { rows: [{ Kind: params[2], Channel: params[3], Body: params[4], UpdatedAtUtc: '2026-10-30T12:00:00.000Z' }], rowCount: 1 };
    }
    if (text.includes('DELETE FROM "NotificationTemplates"')) { state.deletes.push(params); return { rows: [], rowCount: state.saved.length ? 1 : 0 }; }
    if (text.includes('INSERT INTO "AuditLogs"')) { state.audits.push(params); return { rows: [], rowCount: 1 }; }
    if (text.includes('SELECT "Name" FROM "Businesses"')) return { rows: [{ Name: 'Taratara Atelier' }] };
    return { rows: [] };
  };
  return { state, query: handle, connect: async () => ({ query: handle, release() {} }) };
}

describe('message template routes', () => {
  it('need the business.settings permission on all four routes', async () => {
    const app = () => createApp(env, makePool(['customers.manage']));
    assert.equal((await call(app(), 'GET', BASE)).status, 403);
    assert.equal((await call(app(), 'PUT', `${BASE}/order.ready/SMS`, { body: 'Ready {order}' })).status, 403);
    assert.equal((await call(app(), 'DELETE', `${BASE}/order.ready/SMS`)).status, 403);
    assert.equal((await call(app(), 'POST', `${BASE}/order.ready/preview`, { body: 'Ready {order}' })).status, 403);
  });

  it('lists every kind with its default wording, allowed placeholders and what is saved per channel', async () => {
    const pool = makePool(['business.settings'], [{ Kind: 'order.ready', Channel: 'SMS', Body: 'Hi, {order} is done', UpdatedAtUtc: '2026-10-29T10:00:00.000Z' }]);
    const result = await call(createApp(env, pool), 'GET', BASE);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items.map((item) => item.kind), ['order.ready', 'order.amended', 'payment.receipt', 'appointment.reminder']);
    const ready = result.body.items[0];
    assert.match(ready.defaultBody, /^Good news from \{business\}/);
    assert.deepEqual(ready.placeholders.map((p) => p.name), ['business', 'order', 'next_step']);
    assert.deepEqual(ready.channels.map((c) => [c.channel, c.usingDefault, c.customBody]), [['SMS', false, 'Hi, {order} is done'], ['WhatsApp', true, null]]);
    assert.equal(result.body.maxLength, 600);
  });

  it('step 16d: WhatsApp wording is fixed: listed as such even if a row was saved earlier, and a save is refused with nothing written', async () => {
    const pool = makePool(['business.settings'], [{ Kind: 'order.ready', Channel: 'WhatsApp', Body: 'Old {order}', UpdatedAtUtc: '2026-10-29T10:00:00.000Z' }]);
    const list = await call(createApp(env, pool), 'GET', BASE);
    assert.deepEqual(list.body.items[0].channels.find((c) => c.channel === 'WhatsApp'), { channel: 'WhatsApp', customBody: null, usingDefault: true, fixed: true, updatedAtUtc: null });
    const refused = await call(createApp(env, pool), 'PUT', `${BASE}/order.ready/WhatsApp`, { body: 'Hello {order}' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'whatsapp_wording_fixed');
    assert.equal(pool.state.upserts.length, 0);
    assert.equal(pool.state.audits.length, 0);
  });

  it('saves a valid wording for one kind and channel, with one audit entry that never holds the text', async () => {
    const pool = makePool(['business.settings']);
    const result = await call(createApp(env, pool), 'PUT', `${BASE}/order.ready/SMS`, { body: '  Hello! Order {order} is ready at {business}. {next_step}  ' });
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.kind, result.body.channel, result.body.usingDefault], ['order.ready', 'SMS', false]);
    assert.equal(result.body.customBody, 'Hello! Order {order} is ready at {business}. {next_step}');
    assert.deepEqual(pool.state.upserts[0].slice(1, 5), [businessId, 'order.ready', 'SMS', 'Hello! Order {order} is ready at {business}. {next_step}']);
    assert.equal(pool.state.upserts[0][5], userId);
    assert.equal(pool.state.audits.length, 1);
    const details = JSON.parse(pool.state.audits[0][3]);
    assert.deepEqual(details, { kind: 'order.ready', channel: 'SMS', action: 'saved' });
    assert.ok(!JSON.stringify(pool.state.audits[0]).includes('Hello!'));
  });

  it('refuses unknown placeholders, links, markup, empty and over-long text, and writes nothing', async () => {
    const pool = makePool(['business.settings']);
    const bad = [
      ['Hi {customer_name}', /Unknown placeholder \{customer_name\}/],
      ['See https://example.com now', /Links are not allowed/],
      ['Pay at www.example.com', /Links are not allowed/],
      ['<b>Ready</b>', /plain text/],
      ['   ', /Write the message text/],
      ['x'.repeat(601), /600 characters/],
      ['Order {order is ready', /only around a placeholder/],
    ];
    for (const [body, pattern] of bad) {
      const result = await call(createApp(env, pool), 'PUT', `${BASE}/order.ready/SMS`, { body });
      assert.equal(result.status, 400, body);
      assert.match(JSON.stringify(result.body), pattern, body);
    }
    assert.equal((await call(createApp(env, pool), 'PUT', `${BASE}/order.ready/SMS`, {})).status, 400);
    assert.equal(pool.state.upserts.length, 0);
    assert.equal(pool.state.audits.length, 0);
  });

  it('refuses a placeholder that belongs to another kind', async () => {
    const pool = makePool(['business.settings']);
    const result = await call(createApp(env, pool), 'PUT', `${BASE}/order.ready/SMS`, { body: 'Total is {total}' });
    assert.equal(result.status, 400);
    assert.match(JSON.stringify(result.body), /Unknown placeholder \{total\}/);
  });

  it('rejects an unknown kind or channel with 400', async () => {
    const pool = makePool(['business.settings']);
    assert.equal((await call(createApp(env, pool), 'PUT', `${BASE}/order.shipped/SMS`, { body: 'Hi {business}' })).status, 400);
    assert.equal((await call(createApp(env, pool), 'PUT', `${BASE}/order.ready/Email`, { body: 'Hi {business}' })).status, 400);
    assert.equal((await call(createApp(env, pool), 'DELETE', `${BASE}/order.ready/Email`)).status, 400);
    assert.equal((await call(createApp(env, pool), 'POST', `${BASE}/order.shipped/preview`, { body: 'Hi' })).status, 400);
  });

  it('previews with sample data and the business name, saving nothing', async () => {
    const pool = makePool(['business.settings']);
    const result = await call(createApp(env, pool), 'POST', `${BASE}/payment.receipt/preview`, { body: '{business}: thanks, {amount} received on {invoice}. {balance_line}' });
    assert.equal(result.status, 200);
    assert.equal(result.body.text, 'Taratara Atelier: thanks, NGN 20000.00 received on INV-2026-00003. Balance remaining: NGN 25000.00.');
    assert.equal(result.body.characters, result.body.text.length);
    assert.equal(result.body.charactersWithOptOut, result.body.characters + 220);
    assert.equal(pool.state.upserts.length, 0);
    const invalid = await call(createApp(env, pool), 'POST', `${BASE}/payment.receipt/preview`, { body: 'Hi {nope}' });
    assert.equal(invalid.status, 400);
  });

  it('resets to the default: one audit entry when a saved wording was removed, none when there was nothing to remove', async () => {
    const saved = makePool(['business.settings'], [{ Kind: 'order.ready', Channel: 'SMS', Body: 'x {order}', UpdatedAtUtc: '2026-10-29T10:00:00.000Z' }]);
    const reset = await call(createApp(env, saved), 'DELETE', `${BASE}/order.ready/SMS`);
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body, { kind: 'order.ready', channel: 'SMS', customBody: null, usingDefault: true, updatedAtUtc: null });
    assert.deepEqual(saved.state.deletes[0], [businessId, 'order.ready', 'SMS']);
    assert.equal(JSON.parse(saved.state.audits[0][3]).action, 'reset');
    const none = makePool(['business.settings']);
    assert.equal((await call(createApp(env, none), 'DELETE', `${BASE}/order.ready/SMS`)).status, 200);
    assert.equal(none.state.audits.length, 0);
  });
});
