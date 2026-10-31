// Step 17c: the retention job under a NOSUPERUSER, NOBYPASSRLS role. Skipped unless DATABASE_URL is set (CI job "node-db").
// Finished customer-message rows older than 180 days and finished email rows older than 90 days go; everything else stays.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { runWithTenantRlsContext, setTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { purgeOldQueueRows, runRetentionOnce } from '../../src/retention/retentionWorker.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const silent = { info() {}, warn() {}, error() {} };

describe('retention job on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role;
  const A = randomUUID(); const B = randomUUID();
  const customer = { [A]: randomUUID(), [B]: randomUUID() };
  const appointment = { [A]: randomUUID(), [B]: randomUUID() };
  const ids = {};
  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

  async function event(biz, status, days, label) {
    const id = randomUUID(); ids[label] = id;
    await db.pool.query(`INSERT INTO "CustomerEventOutbox" ("Id","BusinessId","CustomerId","Channel","Address","Kind","SubjectId","DedupeKey","Status","CreatedAtUtc","UpdatedAtUtc")
      VALUES ($1,$2,$3,'SMS','+2348000000000','order.ready',$4,$5,$6,$7,$7)`, [id, biz, customer[biz], randomUUID(), `k-${id}`, status, ago(days)]);
  }
  async function reminder(biz, status, days, label) {
    const id = randomUUID(); ids[label] = id;
    await db.pool.query(`INSERT INTO "CustomerMessageOutbox" ("Id","BusinessId","AppointmentId","CustomerId","Channel","Address","AppointmentStartUtc","OffsetMinutes","DueAtUtc","Status","CreatedAtUtc","UpdatedAtUtc")
      VALUES ($1,$2,$3,$4,'SMS','+2348000000000',now() + interval '40 days',1440,now() + interval '39 days',$5,$6,$6)`, [id, biz, appointment[biz], customer[biz], status, ago(days)]);
  }
  async function email(biz, status, days, label) {
    const id = randomUUID(); ids[label] = id;
    await db.pool.query(`INSERT INTO "EmailOutbox" ("Id","Attempts","BusinessId","CreatedAtUtc","NextAttemptUtc","Status","Subject","TextBody","ToAddress")
      VALUES ($1,0,$2,$3,$3,$4,'Subject','',$5)`, [id, biz, ago(days), status, `x-${id}@example.test`]);
  }
  const exists = async (label) => (await db.pool.query('SELECT 1 FROM (SELECT "Id" FROM "CustomerEventOutbox" UNION ALL SELECT "Id" FROM "CustomerMessageOutbox" UNION ALL SELECT "Id" FROM "EmailOutbox") t WHERE "Id" = $1', [ids[label]])).rows.length === 1;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_retention');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    for (const [biz, name] of [[A, 'Retention A'], [B, 'Retention B']]) {
      await db.pool.query(`INSERT INTO "Businesses" ("Id","CreatedAtUtc","CurrencyCode","IsActive","Name","TimeZoneId") VALUES ($1, now(), 'NGN', true, $2, 'UTC')`, [biz, name]);
      const location = randomUUID();
      await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Main',TRUE,now())`, [location, biz]);
      await db.pool.query(`INSERT INTO "Customers" ("Id","BusinessId","CreatedAtUtc","FullName","Status") VALUES ($1,$2,now(),'Ada Customer','Active')`, [customer[biz], biz]);
      await db.pool.query(`INSERT INTO "Appointments" ("Id","BusinessId","Type","CustomerId","LocationId","StartUtc","EndUtc","TimeZoneId","Status","CreatedAtUtc")
        VALUES ($1,$2,'Fitting',$3,$4,now() + interval '40 days', now() + interval '40 days 1 hour','UTC','Scheduled',now())`, [appointment[biz], biz, customer[biz], location]);
    }
    await event(A, 'Sent', 200, 'evASentOld'); await event(A, 'Cancelled', 181, 'evACancelledOld'); await event(A, 'Failed', 200, 'evAFailedOld');
    await event(A, 'Sent', 100, 'evASentRecent'); await event(A, 'Pending', 400, 'evAPendingOld'); await event(A, 'Leased', 400, 'evALeasedOld');
    await event(B, 'Sent', 200, 'evBSentOld'); await event(B, 'Sent', 10, 'evBSentRecent');
    await reminder(A, 'Sent', 200, 'remASentOld'); await reminder(A, 'Pending', 400, 'remAPendingOld'); await reminder(B, 'Cancelled', 190, 'remBCancelledOld'); await reminder(B, 'Failed', 20, 'remBFailedRecent');
    await email(A, 'Sent', 91, 'mailASentOld'); await email(A, 'Failed', 100, 'mailAFailedOld'); await email(A, 'Sent', 30, 'mailASentRecent'); await email(A, 'Pending', 200, 'mailAPendingOld');
    await email(null, 'Sent', 100, 'mailNoneSentOld'); await email(null, 'Failed', 10, 'mailNoneFailedRecent'); await email(B, 'Failed', 95, 'mailBFailedOld');
  });
  after(async () => { await role?.close(); await db?.drop(); });

  it('the migration adds the suspension columns and the three retention indexes', async () => {
    const cols = (await db.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Businesses' AND column_name IN ('SuspendedAtUtc','SuspendedReason')`)).rows.length;
    assert.equal(cols, 2);
    const idx = (await db.pool.query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'IX\\_%\\_Retention' ORDER BY indexname`)).rows.map((r) => r.indexname);
    assert.deepEqual(idx, ['IX_CustomerEventOutbox_Retention', 'IX_CustomerMessageOutbox_Retention', 'IX_EmailOutbox_Retention']);
  });

  it('a pass inside one business removes only that business\'s old finished rows', async () => {
    const result = await runWithTenantRlsContext(async () => {
      setTenantRlsContext(A);
      return purgeOldQueueRows(role.pool, { businessId: A });
    });
    assert.deepEqual(result, { customerEvents: 3, customerReminders: 1, emails: 2 });
    for (const gone of ['evASentOld', 'evACancelledOld', 'evAFailedOld', 'remASentOld', 'mailASentOld', 'mailAFailedOld']) assert.equal(await exists(gone), false, gone);
    for (const kept of ['evBSentOld', 'remBCancelledOld', 'mailBFailedOld', 'mailNoneSentOld']) assert.equal(await exists(kept), true, `${kept} belongs to another scope and stays`);
  });

  it('the full run cleans every other business and the rows that belong to no business, and keeps recent and unfinished rows', async () => {
    const result = await runRetentionOnce(role.pool, { log: silent });
    assert.deepEqual(result, { customerEvents: 1, customerReminders: 1, emails: 2 });
    for (const gone of ['evBSentOld', 'remBCancelledOld', 'mailBFailedOld', 'mailNoneSentOld']) assert.equal(await exists(gone), false, gone);
    for (const kept of ['evASentRecent', 'evAPendingOld', 'evALeasedOld', 'evBSentRecent', 'remAPendingOld', 'remBFailedRecent', 'mailASentRecent', 'mailAPendingOld', 'mailNoneFailedRecent']) {
      assert.equal(await exists(kept), true, `${kept} stays`);
    }
  });

  it('a second run changes nothing', async () => {
    assert.deepEqual(await runRetentionOnce(role.pool, { log: silent }), { customerEvents: 0, customerReminders: 0, emails: 0 });
  });

  it('a large backlog is removed in batches', async () => {
    for (let i = 0; i < 5; i += 1) await event(A, 'Sent', 300 + i, `bulk${i}`);
    const result = await runRetentionOnce(role.pool, { log: silent, batch: 2 });
    assert.equal(result.customerEvents, 5);
    for (let i = 0; i < 5; i += 1) assert.equal(await exists(`bulk${i}`), false);
  });

  it('the role has no tenant outside a scope, so a bare query sees none of these rows', async () => {
    const seen = await runWithTenantRlsContext(() => role.pool.query('SELECT count(*)::int AS n FROM "CustomerEventOutbox"'));
    assert.equal(seen.rows[0].n, 0);
  });
});
