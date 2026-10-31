import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAppointmentRemindersOnce } from '../src/notifications/appointmentReminderWorker.js';

describe('appointment reminder retries', () => {
  it('marks a reminder failed after the final leased attempt', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const leaseUntil = new Date(now.getTime() + 300_000);
    const updates = [];
    const pool = {
      async query(sql, values) {
        if (sql.includes('SELECT \"Id\" FROM \"Businesses\"')) return { rows: [{ Id: '11111111-1111-4111-8111-111111111111' }] };
        if (sql.includes('WITH picked')) return { rows: [{ Id: 'reminder-1', BusinessId: '11111111-1111-4111-8111-111111111111', Attempts: 6, LeaseUntilUtc: leaseUntil }] };
        if (sql.includes('SET "Status" = $3')) { updates.push(values); return { rowCount: 1, rows: [] }; }
        return { rowCount: 0, rows: [] };
      },
      async connect() {
        return {
          async query(sql) {
            if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
            if (sql.includes('FROM "AppointmentReminders" reminder')) throw new Error('database unavailable');
            return { rows: [] };
          },
          release() {},
        };
      },
    };

    const result = await dispatchAppointmentRemindersOnce(pool, { now, maxAttempts: 6, log: { error() {} } });
    assert.deepEqual(result, { claimed: 1, sent: 0, cancelled: 0, stale: 0, retried: 0, failed: 1 });
    assert.equal(updates.length, 1);
    assert.equal(updates[0][2], 'Failed');
  });
});