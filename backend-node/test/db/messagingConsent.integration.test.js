// Step-08c: the staff consent routes against real PostgreSQL as a NOSUPERUSER, NOBYPASSRLS role: the note rule for OptedIn,
// the fixed staff source, the recorded-by user, the customerOptedOut flag in the list, and cross-business isolation.
// Fixtures and row checks use the superuser pool; the app only sees the restricted pool. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const NOTE = 'Agreed by phone on 2026-10-25';

describe('staff consent routes under a restricted role', { skip: !url }, () => {
  let db; let role; let api; let A; let B; let tokenA; let userA;

  async function addCustomer(businessId) {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Customer','Active')`, [id, businessId]);
    return id;
  }
  async function addPreference(businessId, customerId, address, status, source) {
    await db.pool.query(
      `INSERT INTO "CustomerMessagingPreferences" ("Id","BusinessId","CustomerId","Channel","Address","ConsentStatus","ConsentSource","ConsentedAtUtc","OptedOutAtUtc") VALUES ($1,$2,$3,'SMS',$4,$5::text,$6,CASE WHEN $5::text='OptedIn' THEN now() END,CASE WHEN $5::text='OptedOut' THEN now() END)`,
      [randomUUID(), businessId, customerId, address, status, source]);
  }
  const put = (customerId, body, channel = 'SMS') => api.call('PUT', `/api/customers/${customerId}/messaging-preferences/${channel}`, { token: tokenA, body });
  const list = (customerId) => api.call('GET', `/api/customers/${customerId}/messaging-preferences`, { token: tokenA });
  const row = async (customerId, address) => (await db.pool.query(`SELECT * FROM "CustomerMessagingPreferences" WHERE "CustomerId"=$1 AND "Address"=$2`, [customerId, address])).rows[0];

  before(async () => {
    db = await createTempDatabase(url, 'avzar_consent');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    const a = await signUp(api, 'ConA'); const b = await signUp(api, 'ConB');
    A = a.businessId; B = b.businessId; tokenA = a.token;
    userA = (await db.pool.query(`SELECT "UserId" FROM "Memberships" WHERE "BusinessId"=$1 LIMIT 1`, [A])).rows[0].UserId;
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop?.(); });

  it('needs a note of at least 5 characters to record OptedIn, and keeps the note, the source and who recorded it', async () => {
    const customerId = await addCustomer(A); const address = '+2348055550001';
    const none = await put(customerId, { address, consent: 'OptedIn' });
    assert.equal(none.status, 400, none.text); assert.equal(none.body.code, 'consent_note_required');
    const short = await put(customerId, { address, consent: 'OptedIn', note: 'ok' });
    assert.equal(short.status, 400); assert.equal(short.body.code, 'consent_note_required');
    assert.equal(await row(customerId, address), undefined, 'a refused request writes nothing');
    const saved = await put(customerId, { address, consent: 'OptedIn', note: NOTE, source: 'anything the client sends' });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.ConsentStatus, 'OptedIn'); assert.equal(saved.body.ConsentNote, NOTE); assert.equal(saved.body.ConsentSource, 'staff_note');
    const stored = await row(customerId, address);
    assert.equal(stored.ConsentNote, NOTE); assert.equal(stored.ConsentSource, 'staff_note'); assert.equal(stored.ConsentRecordedByUserId, userA);
    assert.ok(stored.ConsentedAtUtc);
  });

  it('records OptedOut without a note, and updates the same number in place', async () => {
    const customerId = await addCustomer(A); const address = '+2348055550002';
    assert.equal((await put(customerId, { address, consent: 'OptedIn', note: NOTE })).status, 200);
    const out = await put(customerId, { address, consent: 'OptedOut' });
    assert.equal(out.status, 200, out.text); assert.equal(out.body.ConsentStatus, 'OptedOut'); assert.equal(out.body.ConsentNote, null);
    const rows = (await db.pool.query(`SELECT count(*)::int AS n FROM "CustomerMessagingPreferences" WHERE "CustomerId"=$1`, [customerId])).rows[0].n;
    assert.equal(rows, 1);
  });

  it('flags a customer\'s own opt-out in the list, and not a staff one', async () => {
    const customerId = await addCustomer(A);
    await addPreference(A, customerId, '+2348055550003', 'OptedOut', 'customer_link');
    await addPreference(A, customerId, '+2348055550004', 'OptedOut', 'staff_note');
    await addPreference(A, customerId, '+2348055550005', 'OptedIn', 'staff_note');
    const listed = await list(customerId);
    assert.equal(listed.status, 200, listed.text);
    const byAddress = Object.fromEntries(listed.body.map((r) => [r.Address, r]));
    assert.equal(byAddress['+2348055550003'].CustomerOptedOut, true);
    assert.equal(byAddress['+2348055550004'].CustomerOptedOut, false);
    assert.equal(byAddress['+2348055550005'].CustomerOptedOut, false);
    // A standing stop on the shared sender also locks the number.
    await db.pool.query(`INSERT INTO "MessagingSuppressions" ("Id","Channel","Address","Source") VALUES ($1,'SMS',$2,'SmsStop')`, [randomUUID(), '+2348055550005']);
    const stopped = (await list(customerId)).body.find((r) => r.Address === '+2348055550005');
    assert.equal(stopped.CustomerOptedOut, true);
  });

  it('does not let staff turn a customer\'s own opt-out into a staff one', async () => {
    const customerId = await addCustomer(A); const address = '+2348055550006';
    await addPreference(A, customerId, address, 'OptedOut', 'customer_link');
    assert.equal((await put(customerId, { address, consent: 'OptedOut', note: 'Customer called' })).status, 200);
    assert.equal((await row(customerId, address)).ConsentSource, 'customer_link', 'the source stays the customer\'s own');
    const back = await put(customerId, { address, consent: 'OptedIn', note: NOTE });
    assert.equal(back.status, 409, back.text); assert.equal(back.body.code, 'customer_opted_out');
  });

  it('answers 404 for another business\'s customer on both routes and writes nothing', async () => {
    const other = await addCustomer(B);
    const got = await list(other);
    assert.equal(got.status, 404, got.text); assert.equal(got.body.code, 'customer_not_found');
    const wrote = await put(other, { address: '+2348055550007', consent: 'OptedIn', note: NOTE });
    assert.equal(wrote.status, 404); assert.equal(wrote.body.code, 'customer_not_found');
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM "CustomerMessagingPreferences" WHERE "CustomerId"=$1`, [other])).rows[0].n, 0);
  });

  // Step-14b: every recorded change writes one audit entry; a refused change writes none; the entry never holds the note or the full number.
  const consentAudits = async (customerId) => (await db.pool.query(`SELECT "DetailsJson"::text AS details, "EntityType", "ActorUserId" FROM "AuditLogs" WHERE "Action" = 'customer_messaging.consent_changed' AND "EntityId" = $1 ORDER BY "CreatedAtUtc"`, [customerId])).rows;

  it('writes one audit entry per recorded change, without the note or the full number', async () => {
    const customerId = await addCustomer(A); const address = '+2348055550008';
    assert.equal((await put(customerId, { address, consent: 'OptedIn', note: NOTE })).status, 200);
    let entries = await consentAudits(customerId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].EntityType, 'Customer'); assert.equal(entries[0].ActorUserId, userA);
    assert.deepEqual(JSON.parse(entries[0].details), { channel: 'SMS', consent: 'OptedIn', source: 'staff_note', addressLast4: '0008' });
    assert.ok(!entries[0].details.includes(NOTE) && !entries[0].details.includes('2348055550008'));
    assert.equal((await put(customerId, { address, consent: 'OptedOut' })).status, 200);
    entries = await consentAudits(customerId);
    assert.equal(entries.length, 2);
    assert.equal(JSON.parse(entries[1].details).consent, 'OptedOut');
  });

  it('writes no audit entry when the change is refused', async () => {
    const customerId = await addCustomer(A); const address = '+2348055550009';
    assert.equal((await put(customerId, { address, consent: 'OptedIn' })).status, 400);
    await addPreference(A, customerId, '+2348055550010', 'OptedOut', 'customer_link');
    assert.equal((await put(customerId, { address: '+2348055550010', consent: 'OptedIn', note: NOTE })).status, 409);
    assert.equal((await put(customerId, { address: 'not a number', consent: 'OptedOut' })).status, 400);
    assert.equal((await consentAudits(customerId)).length, 0);
    const other = await addCustomer(B);
    assert.equal((await put(other, { address, consent: 'OptedOut' })).status, 404);
    assert.equal((await consentAudits(other)).length, 0);
  });
});
