// Step 16d: WhatsApp inbound STOP and START against real PostgreSQL as a NOSUPERUSER, NOBYPASSRLS role: Meta's verify handshake, the
// signature-checked webhook, the sender-wide stop shared by two businesses (WhatsApp only: the same number's SMS consent is untouched),
// the dispatcher cancelling a queued message, and the migration 0042 source check.
// Fixtures and row checks use the superuser pool; the app only sees the restricted pool. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { runWithTenantRlsContext, setTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { customerMessagingConsent } from '../../src/messaging/provider.js';
import { queueCustomerEvent } from '../../src/messaging/customerEvents.js';
import { dispatchCustomerEventsOnce } from '../../src/messaging/customerEventWorker.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const APP_SECRET = 'meta-app-secret-for-tests';
const VERIFY = 'meta-verify-token';
const PHONE_NUMBER_ID = '1001';
const SHARED_DIGITS = '2348011112222';
const SHARED_PHONE = `+${SHARED_DIGITS}`;
const PATH = '/api/messaging/whatsapp/webhook';

describe('WhatsApp stop under a restricted role', { skip: !url }, () => {
  let db; let role; let api;
  let A; let B; let customerA; let customerB;

  async function addCustomer(businessId, channels) {
    const customerId = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Customer','Active')`, [customerId, businessId]);
    for (const channel of channels) {
      await db.pool.query(`INSERT INTO "CustomerMessagingPreferences" ("Id","BusinessId","CustomerId","Channel","Address","ConsentStatus","ConsentSource","ConsentedAtUtc") VALUES ($1,$2,$3,$4,$5,'OptedIn','staff_note',now())`, [randomUUID(), businessId, customerId, channel, SHARED_PHONE]);
    }
    return customerId;
  }
  const inTenant = (businessId, work) => runWithTenantRlsContext(async () => { setTenantRlsContext(businessId); return work(); });
  const consentFor = (businessId, customerId, channel) => inTenant(businessId, () => customerMessagingConsent(role.pool, { businessId, customerId, channel, address: SHARED_PHONE }));
  const bodyOf = (messages, phoneNumberId = PHONE_NUMBER_ID) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, messages } }] }] });
  const text = (body, from = SHARED_DIGITS) => ({ from, id: `wamid.${randomUUID()}`, type: 'text', text: { body } });
  const webhook = (raw, secret = APP_SECRET) => api.call('POST', PATH, { body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
  const stops = async (channel = 'WhatsApp') => (await db.pool.query(`SELECT "Source","LiftedAtUtc" FROM "MessagingSuppressions" WHERE "Channel"=$1 AND "Address"=$2 ORDER BY "CreatedAtUtc"`, [channel, SHARED_PHONE])).rows;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_whatsapp');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool, { META_WHATSAPP_APP_SECRET: APP_SECRET, META_WHATSAPP_VERIFY_TOKEN: VERIFY, META_WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID });
    A = (await signUp(api, 'WaA')).businessId; B = (await signUp(api, 'WaB')).businessId;
    customerA = await addCustomer(A, ['WhatsApp']);
    customerB = await addCustomer(B, ['WhatsApp', 'SMS']);
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop?.(); });

  it('answers Meta\'s verify handshake only for the right token', async () => {
    const ok = await api.call('GET', `${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.text, '1158201444');
    assert.equal((await api.call('GET', `${PATH}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
  });

  it('rejects a bad signature, ordinary text and another number\'s message, and records nothing', async () => {
    const stop = bodyOf([text('STOP')]);
    assert.equal((await webhook(stop, 'other-secret')).status, 403);
    assert.equal((await api.call('POST', PATH, { body: stop, headers: { 'content-type': 'application/json' } })).status, 403);
    assert.equal((await webhook(bodyOf([text('can I move my fitting?')]))).status, 200);
    assert.equal((await webhook(bodyOf([text('STOP')], '9999'))).status, 200);
    assert.deepEqual(await stops(), []);
    assert.equal(await consentFor(B, customerB, 'WhatsApp'), true);
  });

  it('turns one STOP into a WhatsApp stop that blocks sending for every business that holds the number, and not for SMS', async () => {
    assert.equal(await consentFor(A, customerA, 'WhatsApp'), true, 'A is opted in and not stopped before the STOP');
    const res = await webhook(bodyOf([text(' Stop. ')]));
    assert.equal(res.status, 200, res.text);
    const rows = await stops();
    assert.equal(rows.length, 1); assert.equal(rows[0].Source, 'WhatsAppStop'); assert.equal(rows[0].LiftedAtUtc, null);
    assert.equal(await consentFor(A, customerA, 'WhatsApp'), false);
    assert.equal(await consentFor(B, customerB, 'WhatsApp'), false);
    assert.equal(await consentFor(B, customerB, 'SMS'), true, 'the same number\'s SMS consent is a different channel');
    await webhook(bodyOf([text('STOP')])); // repeating adds no second standing stop
    assert.equal((await stops()).length, 1);
    assert.deepEqual(await stops('SMS'), []);
  });

  it('does not queue a new message for a stopped number, and the dispatcher cancels one queued before the STOP', async () => {
    const queued = await inTenant(B, () => queueCustomerEvent(role.pool, { businessId: B, customerId: customerB, kind: 'order.ready', subjectId: randomUUID(), dedupeKey: `order.ready:${randomUUID()}` }));
    assert.equal(queued, 1, 'only the SMS row: the stopped WhatsApp address is skipped at queue time');
    const { rows } = await db.pool.query(`SELECT "Channel" FROM "CustomerEventOutbox" WHERE "BusinessId"=$1`, [B]);
    assert.deepEqual(rows.map((r) => r.Channel), ['SMS']);
    // A message that was already waiting when the STOP arrived (inserted directly, as if queued earlier).
    await db.pool.query(`INSERT INTO "CustomerEventOutbox" ("Id","BusinessId","CustomerId","Channel","Address","Kind","SubjectId","DedupeKey") VALUES ($1,$2,$3,'WhatsApp',$4,'order.ready',$5,$6)`, [randomUUID(), B, customerB, SHARED_PHONE, randomUUID(), `order.ready:early-${randomUUID()}`]);
    const sent = [];
    const result = await inTenant(B, () => dispatchCustomerEventsOnce(role.pool, { now: new Date(Date.now() + 5000), env: {}, provider: { async send(message) { sent.push(message); return { providerMessageId: 'x' }; } }, log: { error() {} } }));
    assert.ok(!sent.some((message) => message.channel === 'WhatsApp'), 'nothing goes out on the stopped channel');
    assert.ok(result.cancelled >= 1);
    const waiting = await db.pool.query(`SELECT "Status" FROM "CustomerEventOutbox" WHERE "BusinessId"=$1 AND "Channel"='WhatsApp'`, [B]);
    assert.deepEqual(waiting.rows.map((r) => r.Status), ['Cancelled']);
  });

  it('lets START lift only the stop; no business consent is changed', async () => {
    const before = (await db.pool.query(`SELECT "Id","ConsentStatus","ConsentedAtUtc","OptedOutAtUtc" FROM "CustomerMessagingPreferences" ORDER BY "Id"`)).rows;
    assert.equal((await webhook(bodyOf([text('START')]))).status, 200);
    assert.notEqual((await stops())[0].LiftedAtUtc, null);
    const after = (await db.pool.query(`SELECT "Id","ConsentStatus","ConsentedAtUtc","OptedOutAtUtc" FROM "CustomerMessagingPreferences" ORDER BY "Id"`)).rows;
    assert.deepEqual(after, before);
    assert.equal(await consentFor(A, customerA, 'WhatsApp'), true);
    assert.equal(await consentFor(B, customerB, 'WhatsApp'), true);
  });

  it('migration 0042: the source check allows WhatsAppStop and still refuses anything else', async () => {
    for (const source of ['SmsStop', 'WhatsAppStop', 'ProviderRefusal']) {
      await db.pool.query(`INSERT INTO "MessagingSuppressions" ("Id","Channel","Address","Source") VALUES ($1,'WhatsApp',$2,$3)`, [randomUUID(), `+23480${Math.floor(Math.random() * 1e7)}`, source]);
    }
    await assert.rejects(db.pool.query(`INSERT INTO "MessagingSuppressions" ("Id","Channel","Address","Source") VALUES ($1,'WhatsApp','+2348099990000','Other')`, [randomUUID()]), (error) => error.code === '23514');
  });
});
