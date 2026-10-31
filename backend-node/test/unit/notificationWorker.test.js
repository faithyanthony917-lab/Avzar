import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueNotificationSweep, startNotificationWorker } from '../../src/notifications/notificationWorker.js';

const now = new Date('2026-10-20T12:00:00.000Z');
const businessId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const taskId = '11111111-2222-4333-8444-555555555555';
const orderId = '22222222-3333-4444-8555-666666666666';
const invoiceId = '33333333-4444-4555-8666-777777777777';
const memberId = '99999999-8888-4777-8666-555555555555';

function fakePool() {
  const calls = [];
  const inserted = new Set();
  const outbox = new Map();
  const pool = {
    calls, outbox,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('SELECT task."Id", task."BusinessId"')) return { rows: [{
        Id: taskId, BusinessId: businessId, Title: 'Press sleeve', DeadlineUtc: new Date('2026-10-20T18:00:00.000Z'),
        AssignedMembershipId: memberId,
      }] };
      if (sql.includes('FROM "QuotationEvents" sent')) return { rows: [{
        Id: orderId, BusinessId: businessId, LocationId: null, QuotedAtUtc: new Date('2026-10-15T12:00:00.000Z'),
      }] };
      if (sql.includes('FROM "Orders" orderRow')) return { rows: [{
        Id: orderId, BusinessId: businessId, OrderNumber: 'ORD-2026-0042', LocationId: null,
      }] };
      if (sql.includes('FROM "Invoices" invoice')) return { rows: [{ Id: invoiceId, BusinessId: businessId, Number: 'INV-2026-0001' }] };
      if (sql.includes('FROM "Memberships" m')) return { rows: [{
        Id: memberId, DisplayName: 'Worker', Email: 'worker@example.test', TimeZoneId: 'UTC', QuietHoursEnabled: false,
        InAppEnabled: true, EmailEnabled: false, PushEnabled: false,
      }] };
      if (sql.includes('INSERT INTO "NotificationOutbox"')) {
        const key = `${values[1]}:${values[2]}:${values[9]}`;
        if (outbox.has(key)) return { rows: [], rowCount: 0 };
        const job = {
          Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
          Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
          InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
          EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
          Status: 'Pending', Attempts: 0, NextAttemptUtc: values[17], CreatedAtUtc: values[17],
        };
        outbox.set(key, job);
        return { rows: [job], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "Notifications"')) {
        const key = values[9];
        if (inserted.has(key)) return { rows: [], rowCount: 0 };
        inserted.add(key);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE "NotificationOutbox"')) return { rows: [], rowCount: 1 };
      if (sql.includes('DELETE FROM "Notifications"')) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
  };
  pool.connect = async () => ({ query: pool.query, release() {} });
  return pool;
}

describe('notification worker', () => {
  it('sweeps due-soon tasks, at-risk orders, unanswered quotations, overdue invoices and retention', async () => {
    const pool = fakePool();
    const results = await enqueueNotificationSweep(pool, { now, log: {} });

    assert.deepEqual(results, { dueSoon: 1, deliveryAtRisk: 1, quotationReminders: 1, overdueInvoices: 1, purged: 2 });
    const inserts = pool.calls.filter((call) => call.sql.includes('INSERT INTO "Notifications"'));
    assert.deepEqual(inserts.map((call) => call.values[4]), [
      'task.due-soon', 'order.delivery-at-risk', 'quotation.reminder', 'invoice.overdue',
    ]);
    assert.equal(inserts[0].values[9], `task.due-soon:${taskId.replaceAll('-', '')}:2026-10-20T18:00:00.000Z`);
    assert.equal(inserts[1].values[9], `order.at-risk:${orderId.replaceAll('-', '')}:20261020`);
    assert.equal(inserts[2].values[9], `quotation.reminder:${orderId}:2026-10-15T12:00:00.000Z`);
    assert.equal(inserts[3].values[9], `invoice.overdue:${invoiceId}`);
    assert.ok(pool.calls.some((call) => call.sql.includes('max(sent."CreatedAtUtc")')
      && call.sql.includes('<= $1::timestamptz - interval \'3 days\'')));
    assert.ok(pool.calls.some((call) => call.sql.includes('DELETE FROM "Notifications"')));
  });

  it('can remain disabled and schedules later, non-overlapping cycles', async () => {
    let cycles = 0;
    const timer = { callback: null, delay: null };
    const pool = { query: async () => { cycles += 1; return { rows: [] }; } };
    const stopDisabled = startNotificationWorker({ pool, enabled: false });
    await stopDisabled();
    const stop = startNotificationWorker({
      pool, startupDelayMs: 50, intervalMinutes: 15, log: {},
      schedule: (callback, delay) => { timer.callback = callback; timer.delay = delay; return timer; },
      cancel: () => {},
    });
    assert.equal(cycles, 0);
    assert.equal(timer.delay, 50);
    await stop();
  });
});