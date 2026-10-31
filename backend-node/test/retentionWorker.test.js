// Step 17c: the retention job with a pool that records what is asked. No database needed.
// Real deletion, tenant scoping and the platform scope are proved in test/db/retention.integration.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOMER_MESSAGE_RETENTION_DAYS, EMAIL_OUTBOX_RETENTION_DAYS, purgeOldQueueRows, runRetentionOnce, startRetentionWorker } from '../src/retention/retentionWorker.js';

const NOW = new Date('2026-10-31T12:00:00Z');
const DAY = 86_400_000;

function recordingPool(rowCountFor = () => 0) {
  const calls = [];
  return { calls, query: async (sql, values = []) => { calls.push({ sql: String(sql), values }); return { rows: [], rowCount: rowCountFor(String(sql), calls.length) }; } };
}
const tableOf = (sql) => /DELETE FROM "(\w+)"/.exec(sql)[1];

describe('retention job (step 17c)', () => {
  it('the periods are 180 days for customer messages and 90 days for the email outbox', () => {
    assert.equal(CUSTOMER_MESSAGE_RETENTION_DAYS, 180);
    assert.equal(EMAIL_OUTBOX_RETENTION_DAYS, 90);
  });

  it('removes only finished rows, by age, from the three queue tables and nothing else', async () => {
    const pool = recordingPool();
    const result = await purgeOldQueueRows(pool, { now: NOW });
    assert.deepEqual(pool.calls.map((c) => tableOf(c.sql)), ['CustomerEventOutbox', 'CustomerMessageOutbox', 'EmailOutbox']);
    for (const call of pool.calls) assert.match(call.sql, /"Status" = ANY\(\$1::text\[\]\)/);
    const [events, reminders, emails] = pool.calls;
    assert.deepEqual(events.values[0], ['Sent', 'Cancelled', 'Failed']);
    assert.deepEqual(reminders.values[0], ['Sent', 'Cancelled', 'Failed']);
    assert.deepEqual(emails.values[0], ['Sent', 'Failed']);
    for (const call of pool.calls) assert.ok(!call.values[0].includes('Pending') && !call.values[0].includes('Leased'), 'a row still to be sent is never removed');
    assert.equal(events.values[1].getTime(), NOW.getTime() - 180 * DAY);
    assert.equal(reminders.values[1].getTime(), NOW.getTime() - 180 * DAY);
    assert.equal(emails.values[1].getTime(), NOW.getTime() - 90 * DAY);
    assert.match(events.sql, /"UpdatedAtUtc" </);
    assert.match(emails.sql, /"CreatedAtUtc" </);
    assert.deepEqual(result, { customerEvents: 0, customerReminders: 0, emails: 0 });
  });

  it('keeps going in batches until a batch comes back short, and counts every row', async () => {
    const pool = recordingPool((sql, n) => (tableOf(sql) === 'CustomerEventOutbox' ? [2, 2, 1][Math.min(n - 1, 2)] : 0));
    const result = await purgeOldQueueRows(pool, { now: NOW, batch: 2 });
    assert.equal(result.customerEvents, 5);
    assert.equal(pool.calls.filter((c) => tableOf(c.sql) === 'CustomerEventOutbox').length, 3);
    assert.equal(pool.calls[0].values[2], 2, 'the batch size is the third parameter');
  });

  it('a table that always returns a full batch stops after ten batches', async () => {
    const pool = recordingPool(() => 5);
    await purgeOldQueueRows(pool, { now: NOW, batch: 5 });
    assert.equal(pool.calls.filter((c) => tableOf(c.sql) === 'EmailOutbox').length, 10);
  });

  it('runRetentionOnce on a pool without row-level security runs once, unscoped, and sums the counts', async () => {
    const pool = recordingPool((sql) => (tableOf(sql) === 'EmailOutbox' ? 3 : 0));
    const result = await runRetentionOnce(pool, { now: NOW, batch: 5, log: { error() {}, info() {} } });
    assert.equal(result.emails, 3);
    assert.equal(pool.calls.filter((c) => tableOf(c.sql) === 'CustomerEventOutbox').length, 1);
  });

  it('the worker does nothing when disabled or without a pool, and stops cleanly', async () => {
    const calls = [];
    assert.equal(typeof (await startRetentionWorker({ pool: null })), 'function');
    await (startRetentionWorker({ pool: recordingPool(), enabled: false, schedule: () => calls.push('x') }))();
    assert.equal(calls.length, 0);
    const timers = [];
    const stop = startRetentionWorker({ pool: recordingPool(), schedule: (fn, ms) => { timers.push(ms); return timers.length; }, cancel: () => timers.push('cancelled') });
    assert.equal(timers[0], 120_000, 'the first pass waits two minutes after start-up');
    await stop();
    assert.ok(timers.includes('cancelled'));
  });

  it('the worker is started from server.js, uses forEachBusiness and its switch is documented', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    assert.match(readFileSync(path.join(root, 'src/server.js'), 'utf8'), /startRetentionWorker\(\{ pool, enabled: env\.RETENTION_WORKER_ENABLED/);
    assert.match(readFileSync(path.join(root, 'src/retention/retentionWorker.js'), 'utf8'), /forEachBusiness\(/);
    assert.match(readFileSync(path.join(root, '.env.example'), 'utf8'), /^RETENTION_WORKER_ENABLED=true$/m);
    assert.match(readFileSync(path.join(root, '../docs/DEPLOYMENT.md'), 'utf8'), /RETENTION_WORKER_ENABLED/);
  });
});
