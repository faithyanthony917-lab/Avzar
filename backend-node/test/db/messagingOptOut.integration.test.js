// Step-08b: customer opt-out against real PostgreSQL as a NOSUPERUSER, NOBYPASSRLS role: the unsubscribe link (preview and confirm),
// the signature-checked Twilio STOP and START webhook, the sender-wide stop shared by two businesses, and the staff 409 guard.
// Fixtures and row checks use the superuser pool; the app only sees the restricted pool. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { runWithTenantRlsContext, setTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { customerMessagingConsent } from '../../src/messaging/provider.js';
import { createUnsubscribeToken, twilioSignature } from '../../src/messaging/optOut.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const SIGNING_KEY = 'integration-signing-key-with-at-least-32-chars'; // the key startApp gives the app
const AUTH_TOKEN = 'twilio-auth-token-for-tests';
const WEBHOOK = 'https://api.example.test/api/messaging/twilio/inbound';
const SHARED_PHONE = '+2348011112222';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('customer opt-out under a restricted role', { skip: !url }, () => {
  let db; let role; let api;
  let A; let B; let tokenA; let customerA; let customerB; let prefA; let prefB;

  async function addCustomerWithPreference(businessId, phone, { channel = 'SMS', status = 'OptedIn' } = {}) {
    const customerId = randomUUID(); const prefId = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Customer','Active')`, [customerId, businessId]);
    await db.pool.query(`INSERT INTO "CustomerMessagingPreferences" ("Id","BusinessId","CustomerId","Channel","Address","ConsentStatus","ConsentSource","ConsentedAtUtc","OptedOutAtUtc") VALUES ($1,$2,$3,$4,$5,$6::text,'staff_note',CASE WHEN $6::text='OptedIn' THEN now() END,CASE WHEN $6::text='OptedOut' THEN now() END)`, [prefId, businessId, customerId, channel, phone, status]);
    return { customerId, prefId };
  }
  const link = (businessId, preferenceId) => createUnsubscribeToken(SIGNING_KEY, { businessId, preferenceId });
  const twilio = (fields, { signWith = AUTH_TOKEN, header } = {}) => {
    const body = new URLSearchParams(fields).toString();
    return api.call('POST', '/api/messaging/twilio/inbound', { body, headers: { ...FORM, 'x-twilio-signature': header ?? twilioSignature(signWith, WEBHOOK, fields) } });
  };
  const stops = async () => (await db.pool.query(`SELECT "Source","LiftedAtUtc" FROM "MessagingSuppressions" WHERE "Address"=$1 ORDER BY "CreatedAtUtc"`, [SHARED_PHONE])).rows;
  const consentFor = (businessId, customerId, address = SHARED_PHONE) => runWithTenantRlsContext(async () => {
    setTenantRlsContext(businessId);
    return customerMessagingConsent(role.pool, { businessId, customerId, channel: 'SMS', address });
  });

  before(async () => {
    db = await createTempDatabase(url, 'avzar_optout');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool, { TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_BASE_URL: 'https://api.example.test' });
    const a = await signUp(api, 'OptA'); const b = await signUp(api, 'OptB');
    A = a.businessId; B = b.businessId; tokenA = a.token;
    ({ customerId: customerA, prefId: prefA } = await addCustomerWithPreference(A, SHARED_PHONE));
    ({ customerId: customerB, prefId: prefB } = await addCustomerWithPreference(B, SHARED_PHONE));
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop?.(); });

  it('previews a link without changing anything, with a masked number', async () => {
    const res = await api.call('POST', '/api/messaging/unsubscribe/preview', { body: { token: link(A, prefA) } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { businessName: 'OptA Tailors', channel: 'SMS', maskedAddress: '+234****2222', alreadyOptedOut: false });
    const { rows } = await db.pool.query('SELECT "ConsentStatus" FROM "CustomerMessagingPreferences" WHERE "Id"=$1', [prefA]);
    assert.equal(rows[0].ConsentStatus, 'OptedIn');
  });

  it('answers a forged link, an unknown preference and another business\'s preference with the same 404', async () => {
    const forged = await api.call('POST', '/api/messaging/unsubscribe/preview', { body: { token: `${link(A, prefA).split('.')[0]}.AAAA` } });
    const unknown = await api.call('POST', '/api/messaging/unsubscribe/confirm', { body: { token: link(A, randomUUID()) } });
    const crossBusiness = await api.call('POST', '/api/messaging/unsubscribe/confirm', { body: { token: link(A, prefB) } }); // validly signed, but B's row is not A's
    for (const res of [forged, unknown, crossBusiness]) { assert.equal(res.status, 404); assert.equal(res.body.code, 'unsubscribe_link_invalid'); }
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "CustomerMessagingPreferences" WHERE "ConsentStatus"='OptedOut'`)).rows[0].n, 0);
  });

  it('confirms an opt-out for that business only, and repeating it changes nothing', async () => {
    const first = await api.call('POST', '/api/messaging/unsubscribe/confirm', { body: { token: link(A, prefA) } });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.optedOut, true);
    const read = async (id) => (await db.pool.query('SELECT "ConsentStatus","ConsentSource","OptedOutAtUtc" FROM "CustomerMessagingPreferences" WHERE "Id"=$1', [id])).rows[0];
    const afterFirst = await read(prefA);
    assert.deepEqual([afterFirst.ConsentStatus, afterFirst.ConsentSource], ['OptedOut', 'customer_link']);
    assert.equal((await read(prefB)).ConsentStatus, 'OptedIn');
    const second = await api.call('POST', '/api/messaging/unsubscribe/confirm', { body: { token: link(A, prefA) } });
    assert.equal(second.status, 200);
    assert.equal((await read(prefA)).OptedOutAtUtc.getTime(), afterFirst.OptedOutAtUtc.getTime());
    assert.equal((await api.call('POST', '/api/messaging/unsubscribe/preview', { body: { token: link(A, prefA) } })).body.alreadyOptedOut, true);
  });

  it('refuses a Twilio request with a wrong or missing signature and records nothing', async () => {
    assert.equal((await twilio({ From: SHARED_PHONE, Body: 'STOP' }, { signWith: 'wrong-token' })).status, 403);
    assert.equal((await twilio({ From: SHARED_PHONE, Body: 'STOP' }, { header: '' })).status, 403);
    assert.deepEqual(await stops(), []);
  });

  it('ignores messages that are not exactly a keyword', async () => {
    const res = await twilio({ From: SHARED_PHONE, Body: 'please stop texting' });
    assert.equal(res.status, 200);
    assert.deepEqual(await stops(), []);
  });

  it('turns one STOP into a stop that blocks sending for every business that holds the number', async () => {
    assert.equal(await consentFor(B, customerB), true, 'B is opted in and not stopped before the STOP');
    const res = await twilio({ From: SHARED_PHONE, Body: ' stop ' });
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /<Response><\/Response>/);
    const rows = await stops();
    assert.equal(rows.length, 1); assert.equal(rows[0].Source, 'SmsStop'); assert.equal(rows[0].LiftedAtUtc, null);
    assert.equal(await consentFor(B, customerB), false);
    assert.equal(await consentFor(A, customerA), false);
    await twilio({ From: SHARED_PHONE, Body: 'STOP' }); // repeating does not add a second standing stop
    assert.equal((await stops()).length, 1);
  });

  it('lets START lift the stop without restoring a consent the customer withdrew', async () => {
    assert.equal((await twilio({ From: SHARED_PHONE, Body: 'START' })).status, 200);
    assert.notEqual((await stops())[0].LiftedAtUtc, null);
    assert.equal(await consentFor(B, customerB), true, 'B never withdrew, so B may message again');
    assert.equal(await consentFor(A, customerA), false, 'A\'s customer used the link; START does not undo that');
  });

  it('stops staff from recording OptedIn over a customer\'s own opt-out, by link or by STOP', async () => {
    const put = (customerId, address, consent = 'OptedIn', source = 'staff_note') => api.call('PUT', `/api/customers/${customerId}/messaging-preferences/SMS`, { token: tokenA, body: { address, consent, source, ...(consent === 'OptedIn' ? { note: 'Agreed at the fitting' } : {}) } });
    // By link: the preference A's customer opted out of through the link.
    const linked = await put(customerA, SHARED_PHONE);
    assert.equal(linked.status, 409, linked.text); assert.equal(linked.body.code, 'customer_opted_out');
    // By STOP: a different customer of A whose number is under a standing stop.
    const phone = '+2348033334444';
    const { customerId } = await addCustomerWithPreference(A, phone, { status: 'Unknown' });
    assert.equal((await put(customerId, phone)).status, 200, 'allowed while there is no stop');
    await twilio({ From: phone, Body: 'STOP' });
    const stopped = await put(customerId, phone);
    assert.equal(stopped.status, 409); assert.equal(stopped.body.code, 'customer_opted_out');
    assert.equal((await put(customerId, phone, 'OptedOut')).status, 200, 'staff may still record an opt-out');
    // The reserved source cannot be used by staff to dress up a record as the customer's own.
    const reserved = await put(customerId, phone, 'OptedOut', 'customer_link');
    assert.equal(reserved.status, 400); assert.equal(reserved.body.code, 'reserved_consent_source');
  });
});
