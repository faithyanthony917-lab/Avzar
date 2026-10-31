// Step-09c: the background workers that rls-webhooks-workers did not run, executed against real PostgreSQL as a NOSUPERUSER,
// NOBYPASSRLS role. Each cycle runs the way its start* function runs it: once per business through forEachBusiness, each inside that
// business's tenant context. Five of the six cycles run on an empty queue: they prove the cycle's SQL runs without a policy or
// permission error for every business. They do not prove which rows each query would pick. The orphan sweep is tested with real rows,
// because under row-level security a wrong tenant would make it delete live media.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { forEachBusiness } from '../../src/db/forEachBusiness.js';
import { enqueueOverdueTaskReminders } from '../../src/email/overdueTaskReminders.js';
import { enqueueNotificationSweep } from '../../src/notifications/notificationWorker.js';
import { dispatchPushDeliveriesOnce } from '../../src/notifications/pushDeliveryWorker.js';
import { runWorkerSummaryCycle } from '../../src/notifications/workerSummaryService.js';
import { dispatchCustomerMessagesOnce } from '../../src/messaging/customerMessageWorker.js';
import { cleanOrphanObjects } from '../../src/storage/orphanCleanup.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const hex = (id) => id.replaceAll('-', '');

describe('background workers under a restricted role', { skip: !url }, () => {
  let db; let role; let A; let B;
  const errors = [];
  const log = { info() {}, warn() {}, error: (...args) => errors.push(args) };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rls_workers');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    const api = await startApp(role.pool);
    try {
      A = await signUp(api, 'wka');
      B = await signUp(api, 'wkb');
    } finally { await api.close(); }
  });
  after(async () => {
    await role?.close();
    await db?.drop();
  });

  it('the pool is a restricted role', async () => { await assertRestrictedRole(role.pool); });

  const cycles = {
    'overdue task reminders': (pool) => enqueueOverdueTaskReminders(pool, { log }),
    'notification sweep': (pool) => enqueueNotificationSweep(pool, { log }),
    'push delivery': (pool) => dispatchPushDeliveriesOnce(pool, { sender: { send: async () => [] }, log }),
    'worker summaries': (pool) => runWorkerSummaryCycle(pool, { log }),
    'customer messages': (pool) => dispatchCustomerMessagesOnce(pool, { provider: { sendSms: async () => ({}) }, log }),
  };
  for (const [name, cycle] of Object.entries(cycles)) {
    it(`${name}: one cycle runs for every business without an error`, async () => {
      errors.length = 0;
      const results = await forEachBusiness(role.pool, () => cycle(role.pool), { log });
      assert.equal(results.length, 2, 'one run for each of the two businesses');
      assert.deepEqual(errors, []);
    });
  }

  it('orphan cleanup deletes only objects with no row, checking each under its own business', async () => {
    const asset = async (businessId) => {
      const id = randomUUID();
      await db.pool.query(`
        INSERT INTO "MediaAssets" ("Id","BusinessId","ContentType","CreatedAtUtc","Height","OriginalFileName","Purpose","Sha256","SizeBytes","Width")
        VALUES ($1,$2,'image/webp',now(),10,'a.webp','DesignImage',$3,100,10)`, [id, businessId, randomBytes(32).toString('hex')]);
      return id;
    };
    const liveA = await asset(A.businessId);
    const liveB = await asset(B.businessId);
    const orphanA = randomUUID();
    const orphanB = randomUUID();
    const strangerBusiness = randomUUID();
    const old = new Date(Date.now() - 72 * 3_600_000);
    const objects = [
      { key: `${hex(A.businessId)}/${hex(liveA)}/orig.webp`, lastModifiedUtc: old, keep: true },
      { key: `${hex(B.businessId)}/${hex(liveB)}/md.webp`, lastModifiedUtc: old, keep: true },
      { key: `${hex(A.businessId)}/${hex(orphanA)}/orig.webp`, lastModifiedUtc: old, keep: false },
      { key: `${hex(B.businessId)}/d/${hex(orphanB)}.bin`, lastModifiedUtc: old, keep: false },
      { key: `${hex(strangerBusiness)}/${hex(randomUUID())}/sm.webp`, lastModifiedUtc: old, keep: false },
      { key: `${hex(A.businessId)}/${hex(randomUUID())}/orig.webp`, lastModifiedUtc: new Date(), keep: true },
      { key: 'not-a-storage-key.txt', lastModifiedUtc: old, keep: true },
    ];
    // A live asset of one business must not be rescued by an asset ID that exists only in the other business.
    objects.push({ key: `${hex(B.businessId)}/${hex(liveA)}/orig.webp`, lastModifiedUtc: old, keep: false });
    const deleted = [];
    const storage = {
      async *list() { for (const object of objects) yield { key: object.key, lastModifiedUtc: object.lastModifiedUtc }; },
      delete: async (key) => { deleted.push(key); },
    };
    const result = await cleanOrphanObjects({ pool: role.pool, storage, log });
    assert.deepEqual([...deleted].sort(), objects.filter((o) => !o.keep).map((o) => o.key).sort());
    assert.equal(result.scanned, objects.length);
    assert.equal(result.deleted, deleted.length);
  });
});
