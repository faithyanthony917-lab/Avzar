import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listPlatformBackgroundJobs, listPlatformFeatureFlags, retryPlatformNotification, updatePlatformFeatureFlag } from '../src/auth/platformOperationsService.js';

const admin = 'ops@example.test';
const allowlist = [admin];

function transactionPool(responses = []) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      const match = responses.find((entry) => sql.includes(entry.match));
      if (match) return typeof match.result === 'function' ? match.result(sql, values) : match.result;
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { calls, connect: async () => client, query: client.query.bind(client) };
}

describe('platform operations', () => {
  it('restricts feature-flag listing to the configured platform-admin allowlist', async () => {
    const pool = { query: async () => ({ rows: [{ Key: 'ready_to_wear_checkout', Description: 'Checkout', Enabled: false }] }) };
    await assert.rejects(() => listPlatformFeatureFlags(pool, 'tenant@example.test', allowlist), (error) => error.code === 'platform_admin_required');
    const result = await listPlatformFeatureFlags(pool, admin, allowlist);
    assert.equal(result[0].key, 'ready_to_wear_checkout');
    assert.equal(result[0].enabled, false);
  });

  it('lists operational job queues without exposing email bodies or notification payloads', async () => {
    let sqlSeen = '';
    const pool = { query: async (sql) => { sqlSeen = sql; return { rows: [] }; } };
    const result = await listPlatformBackgroundJobs(pool, admin, allowlist, { limit: 50, status: 'Failed' });
    assert.deepEqual(result.items, []);
    assert.match(sqlSeen, /WorkerSummaryJobs/);
    assert.match(sqlSeen, /AppointmentReminders/);
    assert.match(sqlSeen, /EmailOutbox/);
    assert.doesNotMatch(sqlSeen, /HtmlBody|TextBody|ToAddress|Body/);
  });

  it('audits feature flag changes in the same transaction', async () => {
    const pool = transactionPool([{ match: 'UPDATE "PlatformFeatureFlags"', result: { rows: [{ Key: 'ready_to_wear_checkout', Enabled: true }], rowCount: 1 } }]);
    const result = await updatePlatformFeatureFlag(pool, admin, allowlist, 'ready_to_wear_checkout', true);
    assert.deepEqual(result, { key: 'ready_to_wear_checkout', enabled: true });
    assert.ok(pool.calls.some((call) => call.sql === 'BEGIN'));
    assert.ok(pool.calls.some((call) => call.sql.includes('INSERT INTO "PlatformAuditLogs"')));
    assert.ok(pool.calls.some((call) => call.sql === 'COMMIT'));
  });

  it('retries only failed jobs and records a platform audit event', async () => {
    const pool = transactionPool([
      { match: 'SELECT "Id","BusinessId","Status" FROM "NotificationOutbox"', result: { rows: [{ Id: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Status: 'Failed' }] } },
    ]);
    const result = await retryPlatformNotification(pool, admin, allowlist, 'notification', '00000000-0000-4000-8000-000000000001');
    assert.equal(result.status, 'Pending');
    assert.ok(pool.calls.some((call) => call.sql.includes("SET \"Status\"='Pending'")));
    assert.ok(pool.calls.some((call) => call.sql.includes('INSERT INTO "PlatformAuditLogs"')));
  });

  it('refuses to retry a job whose state changed from Failed', async () => {
    const pool = transactionPool([{ match: 'SELECT "Id","BusinessId","Status" FROM "PushDeliveries"', result: { rows: [{ Id: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Status: 'Accepted' }] } }]);
    await assert.rejects(() => retryPlatformNotification(pool, admin, allowlist, 'push', '00000000-0000-4000-8000-000000000001'), (error) => error.code === 'job_not_failed');
    assert.equal(pool.calls.some((call) => call.sql.includes('SET "Status"=\'Pending\'')), false);
  });
});
