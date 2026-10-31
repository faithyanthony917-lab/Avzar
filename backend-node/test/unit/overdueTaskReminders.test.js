import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueOverdueTaskReminders, startOverdueTaskReminderWorker } from '../../src/email/overdueTaskReminders.js';

const now = new Date('2026-10-18T12:00:00.000Z');
const candidate = {
  Id: '11111111-2222-3333-4444-555555555555',
  BusinessId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  Title: 'Fit the jacket', DeadlineUtc: new Date('2026-10-17T11:30:00.000Z'),
  AssignedMembershipId: '99999999-8888-4777-8666-555555555555',
  DisplayName: 'Ada Worker', Email: ' Ada@Example.test ',
};

function fakePool(rows = [candidate], rowCount = 1) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM "ProductionTasks" task')) return { rows };
      if (sql.includes('FROM "Memberships" m')) return { rows: rows.map((task) => ({
        Id: task.AssignedMembershipId, DisplayName: task.DisplayName, Email: task.Email, TimeZoneId: 'UTC',
        QuietHoursEnabled: false, InAppEnabled: true, EmailEnabled: true, PushEnabled: false,
      })) };
      if (sql.includes('INSERT INTO "NotificationOutbox"')) return { rows: [{
        Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
        Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
        InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
        EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
        Status: 'Pending', CreatedAtUtc: values[19],
      }], rowCount: 1 };
      if (sql.includes('INSERT INTO "Notifications"')) return { rows: [], rowCount };
      if (sql.includes('INSERT INTO "EmailOutbox"')) return { rows: [], rowCount };
      if (sql.includes('UPDATE "NotificationOutbox"')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  pool.connect = async () => ({ query: pool.query, release() {} });
  return pool;
}

describe('overdue task reminders', () => {
  it('selects active same-business assignees and queues in-app and normalized once-daily email notices', async () => {
    const pool = fakePool();
    const queued = await enqueueOverdueTaskReminders(pool, { now });

    assert.equal(queued, 1);
    const selection = pool.calls[0];
    assert.match(selection.sql, /business\."IsActive"/);
    assert.match(selection.sql, /membership\."BusinessId" = task\."BusinessId" AND membership\."Status" = 0/);
    assert.match(selection.sql, /task\."Status" IN \('Pending', 'Scheduled', 'InProgress', 'Paused'\)/);
    assert.match(selection.sql, /notification\."DeduplicationKey"/);
    assert.deepEqual(selection.values, [now, '20261018', 500]);

    const notification = pool.calls.find((call) => call.sql.includes('INSERT INTO "Notifications"'));
    assert.equal(notification.values[9], 'task.overdue:11111111222233334444555555555555:20261018');
    const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO "EmailOutbox"'));
    assert.equal(insert.values[1], candidate.BusinessId);
    assert.equal(insert.values[2], now);
    assert.equal(insert.values[8], 'task.overdue:11111111222233334444555555555555:20261018');
    assert.match(insert.values[6], /Hello Ada Worker/);
    assert.match(insert.values[6], /2026-10-17 11:30 UTC/);
    assert.equal(insert.values[7], 'Ada@Example.test');
  });

  it('still creates an in-app notice when the assignee has an invalid email address', async () => {
    const pool = fakePool([{ ...candidate, Email: 'Ada <ada@example.test>' }]);
    assert.equal(await enqueueOverdueTaskReminders(pool, { now }), 1);
    assert.ok(pool.calls.some((call) => call.sql.includes('INSERT INTO "Notifications"')));
    assert.ok(!pool.calls.some((call) => call.sql.includes('INSERT INTO "EmailOutbox"')));
  });

  it('clamps batch size and keeps the worker disabled without a pool or when configured off', async () => {
    const pool = fakePool([]);
    await enqueueOverdueTaskReminders(pool, { now, batchLimit: 9000 });
    assert.equal(pool.calls[0].values[2], 5000);

    let calls = 0;
    const disabledStop = startOverdueTaskReminderWorker({ pool: { query: async () => { calls++; return { rows: [] }; } }, enabled: false });
    await disabledStop();
    const noPoolStop = startOverdueTaskReminderWorker({ pool: null });
    await noPoolStop();
    assert.equal(calls, 0);
  });

  it('polls again after the configured interval and cancels on stop', async () => {
    const timers = [];
    const cancelled = [];
    const pool = { query: async () => ({ rows: [] }) };
    const stop = startOverdueTaskReminderWorker({
      pool, enabled: true, pollSeconds: 900, log: {},
      schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
      cancel: (timer) => cancelled.push(timer),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers[0].delay, 900_000);
    await stop();
    assert.deepEqual(cancelled, [timers[0]]);
  });
});