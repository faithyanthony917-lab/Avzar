// Step 5: the email outbox dispatcher against a real PostgreSQL, with several workers at once. The unit tests in
// test/unit/emailDispatcher.test.js use a fake pool and cannot show what FOR UPDATE SKIP LOCKED, the lease and the
// lease-guarded UPDATE do between real connections. Each test gets its own throw-away database. The clock is the `now`
// argument of dispatchOnce, so lease expiry and retry delays are tested without waiting.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { dispatchOnce } from '../../src/email/dispatcher.js';
import { TransportResult } from '../../src/email/transportResult.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const T0 = new Date('2026-10-18T12:00:00.000Z');
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);
const options = (overrides = {}) => ({ batchSize: 5, leaseMinutes: 5, maxAttempts: 3, ...overrides });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe('email dispatcher with several workers on PostgreSQL', { skip: !url }, () => {
  let db;
  let pool;

  before(async () => {
    db = await createTempDatabase(url, 'avzar_mail');
    pool = db.pool;
    await migrate(pool, MIGRATIONS_DIR, quiet);
  });
  after(async () => { await db?.drop(); });
  beforeEach(async () => { await pool.query('DELETE FROM "EmailOutbox"'); });

  async function enqueue(count, { status = 'Pending', nextAttempt = at(-60), lease = null, html = '<p>Private link</p>' } = {}) {
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await pool.query(
        `INSERT INTO "EmailOutbox" ("Id","Attempts","CreatedAtUtc","NextAttemptUtc","Status","Subject","TextBody","HtmlBody","ToAddress","LeaseUntilUtc")
         VALUES ($1,0,$2,$3,$4,'Concurrency test','one-time-link',$5,$6,$7)`,
        [id, at(-120 + i), nextAttempt, status, html, `${id}@example.test`, lease]);
    }
    return ids;
  }
  const row = async (id) => (await pool.query('SELECT * FROM "EmailOutbox" WHERE "Id" = $1', [id])).rows[0];
  const leasedCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM "EmailOutbox" WHERE "LeaseUntilUtc" IS NOT NULL AND "Status" = 'Pending'`)).rows[0].n;

  it('several workers draining one queue send every message exactly once', async () => {
    const ids = await enqueue(40);
    const sent = [];
    const transport = {
      async send(email) {
        sent.push(email.messageId);
        await sleep(2); // lets the workers interleave
        return TransportResult.ok(`provider-${email.messageId}`);
      },
    };
    const worker = async () => {
      let handled = 0;
      for (;;) {
        const n = await dispatchOnce({ pool, transport, options: options(), now: T0, log: {} });
        if (n === 0) return handled;
        handled += n;
      }
    };

    const handledByWorker = await Promise.all([worker(), worker(), worker(), worker()]);
    // A worker may see an empty queue while another still holds the last rows; sweep once so the check is about duplicates, not timing.
    const sweep = await worker();

    assert.equal(sent.length, 40, 'every message was handed to the transport');
    assert.equal(new Set(sent).size, 40, 'no message was handed to the transport twice');
    assert.equal(handledByWorker.reduce((a, b) => a + b, 0) + sweep, 40);
    const { rows } = await pool.query('SELECT "Id","Status","Attempts","LeaseUntilUtc","ProviderMessageId" FROM "EmailOutbox"');
    assert.equal(rows.length, 40);
    for (const r of rows) {
      assert.equal(r.Status, 'Sent');
      assert.equal(r.Attempts, 1, `message ${r.Id} was claimed more than once`);
      assert.equal(r.LeaseUntilUtc, null);
      assert.equal(r.ProviderMessageId, `provider-${r.Id}`);
    }
    assert.deepEqual(new Set(rows.map((r) => r.Id)), new Set(ids));
  });

  it('two workers that claim at the same time get disjoint batches while both are still sending', async () => {
    await enqueue(10);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const handedOut = { a: [], b: [] };
    const transportFor = (name) => ({ async send(email) { handedOut[name].push(email.messageId); await gate; return TransportResult.ok(); } });

    const a = dispatchOnce({ pool, transport: transportFor('a'), options: options({ batchSize: 5 }), now: T0, log: {} });
    const b = dispatchOnce({ pool, transport: transportFor('b'), options: options({ batchSize: 5 }), now: T0, log: {} });

    // Both claims are visible in the database while the transports are blocked: 5 + 5 distinct leased rows, each claimed once.
    await waitFor(async () => (await leasedCount()) === 10, 'both workers to hold a lease');
    const leased = (await pool.query(`SELECT "Attempts","LeaseUntilUtc" FROM "EmailOutbox" WHERE "Status" = 'Pending'`)).rows;
    assert.equal(leased.length, 10);
    for (const r of leased) {
      assert.equal(r.Attempts, 1);
      assert.equal(r.LeaseUntilUtc.getTime(), at(5 * 60).getTime());
    }

    release();
    const counts = await Promise.all([a, b]);
    assert.deepEqual(counts, [5, 5]);
    const all = [...handedOut.a, ...handedOut.b];
    assert.equal(all.length, 10);
    assert.equal(new Set(all).size, 10, 'the two batches do not overlap');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "EmailOutbox" WHERE "Status" = 'Sent'`)).rows[0].n, 10);
  });

  it('does not claim a leased message before its lease expires, and claims it again afterwards', async () => {
    const [id] = await enqueue(1);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // Worker 1 claims the message and then "hangs": its transport call never returns until the end of the test.
    const crashed = dispatchOnce({
      pool, options: options(), now: T0, log: {},
      transport: { async send() { await gate; return TransportResult.ok('late-worker'); } },
    });
    await waitFor(async () => (await leasedCount()) === 1, 'worker 1 to take the lease');
    assert.equal((await row(id)).Attempts, 1);

    const sentBy2 = [];
    const transport2 = { async send(email) { sentBy2.push(email.messageId); return TransportResult.ok('fresh-worker'); } };

    // Lease is 5 minutes: 4 minutes in, the message is still owned by worker 1.
    assert.equal(await dispatchOnce({ pool, transport: transport2, options: options(), now: at(4 * 60), log: {} }), 0);
    assert.deepEqual(sentBy2, []);
    // Exactly at the expiry the lease is still valid (the claim needs LeaseUntilUtc < now).
    assert.equal(await dispatchOnce({ pool, transport: transport2, options: options(), now: at(5 * 60), log: {} }), 0);

    // 6 minutes in the lease has expired: worker 2 takes over and delivers.
    assert.equal(await dispatchOnce({ pool, transport: transport2, options: options(), now: at(6 * 60), log: {} }), 1);
    assert.deepEqual(sentBy2, [id]);
    const afterTakeover = await row(id);
    assert.equal(afterTakeover.Status, 'Sent');
    assert.equal(afterTakeover.Attempts, 2);
    assert.equal(afterTakeover.ProviderMessageId, 'fresh-worker');
    assert.equal(afterTakeover.LeaseUntilUtc, null);

    // Worker 1 wakes up and reports success. Its lease is gone, so the guarded UPDATE must change nothing.
    release();
    assert.equal(await crashed, 1);
    const final = await row(id);
    assert.equal(final.Status, 'Sent');
    assert.equal(final.ProviderMessageId, 'fresh-worker', 'the stale worker did not overwrite the result');
    assert.equal(final.Attempts, 2);
  });

  it('a stale worker cannot overwrite a message that another worker has re-queued for retry', async () => {
    const [id] = await enqueue(1);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const stale = dispatchOnce({
      pool, options: options(), now: T0, log: {},
      transport: { async send() { await gate; return TransportResult.reject('stale rejection'); } },
    });
    await waitFor(async () => (await leasedCount()) === 1, 'the first worker to take the lease');

    // Lease expired: the second worker claims it and the provider asks for a retry.
    await dispatchOnce({ pool, options: options(), now: at(6 * 60), log: {}, transport: { send: async () => TransportResult.retry('provider timeout') } });
    const queued = await row(id);
    assert.equal(queued.Status, 'Pending');
    assert.equal(queued.LastError, 'provider timeout');
    assert.equal(queued.LeaseUntilUtc, null);

    release();
    await stale;
    const final = await row(id);
    assert.equal(final.Status, 'Pending', 'the stale permanent rejection was ignored');
    assert.equal(final.LastError, 'provider timeout');
    assert.equal(final.TextBody, 'one-time-link', 'the body was not purged by the stale worker');
  });

  it('never claims messages that are Sent or Failed, even when an old lease has expired', async () => {
    await enqueue(1, { status: 'Sent', lease: at(-3600) });
    await enqueue(1, { status: 'Failed', lease: at(-3600) });
    let sends = 0;
    const n = await dispatchOnce({ pool, options: options(), now: T0, log: {}, transport: { send: async () => { sends += 1; return TransportResult.ok(); } } });
    assert.equal(n, 0);
    assert.equal(sends, 0);
  });

  it('does not claim a message before its next attempt time', async () => {
    await enqueue(1, { nextAttempt: at(30) });
    const transport = { send: async () => TransportResult.ok() };
    assert.equal(await dispatchOnce({ pool, transport, options: options(), now: at(29), log: {} }), 0);
    assert.equal(await dispatchOnce({ pool, transport, options: options(), now: at(30), log: {} }), 1);
  });

  it('reschedules transient failures with the retry delay and gives up after the maximum number of attempts', async () => {
    const [id] = await enqueue(1);
    const failing = { send: async () => TransportResult.retry('provider timeout') };
    const run = (now) => dispatchOnce({ pool, transport: failing, options: options({ maxAttempts: 3 }), now, log: {} });

    assert.equal(await run(T0), 1); // attempt 1: retry in 30 seconds
    let r = await row(id);
    assert.equal(r.Status, 'Pending');
    assert.equal(r.Attempts, 1);
    assert.equal(r.NextAttemptUtc.getTime(), at(30).getTime());
    assert.equal(r.LeaseUntilUtc, null);

    assert.equal(await run(at(10)), 0, 'not due yet');
    assert.equal(await run(at(31)), 1); // attempt 2: retry in 2 minutes
    r = await row(id);
    assert.equal(r.Status, 'Pending');
    assert.equal(r.Attempts, 2);
    assert.equal(r.NextAttemptUtc.getTime(), at(31 + 120).getTime());

    assert.equal(await run(at(31 + 121)), 1); // attempt 3: out of attempts
    r = await row(id);
    assert.equal(r.Status, 'Failed');
    assert.equal(r.Attempts, 3);
    assert.match(r.LastError, /^Gave up after 3 attempts: provider timeout/);
    assert.equal(r.TextBody, '');
    assert.equal(r.HtmlBody, null);
    assert.ok(r.BodyPurgedAtUtc instanceof Date);
    assert.equal(r.LeaseUntilUtc, null);
    assert.equal(await run(at(31 + 121 + 100_000)), 0, 'a Failed message is never claimed again');
  });
});
