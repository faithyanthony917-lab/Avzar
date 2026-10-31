import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNotificationOutboxOnce } from '../../src/notifications/notificationOutboxWorker.js';
import { currentTenantRlsBusinessId } from '../../src/db/tenantRlsContext.js';

const now = new Date('2026-10-20T12:00:00.000Z');
const jobId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function fakePool({ failNotifications = false, initial = {}, appointment = null, additionalJobs = [] } = {}) {
  let shouldFailNotifications = failNotifications;
  const state = {
    jobs: [{
      Id: jobId, BusinessId: '11111111-2222-4333-8444-555555555555',
      RecipientMembershipId: '22222222-3333-4444-8555-666666666666',
      Category: 'tasks', EventType: 'task.assigned', Title: 'Task assigned', Body: 'A task is ready.',
      TargetKind: 'task', TargetId: '33333333-4444-4555-8666-777777777777', DeduplicationKey: 'task.assigned:v1',
      InAppEnabled: true, EmailToAddress: null, EmailSubject: null, EmailTemplateKey: null, EmailTextBody: null,
      EmailDeduplicationKey: null, EmailNextAttemptUtc: null, Status: 'Pending', Attempts: 0,
      NextAttemptUtc: now, LeaseUntilUtc: null, CreatedAtUtc: now, ...initial,
    }, ...additionalJobs],
    notifications: [],
    appointment,
  };
  let snapshot = null;
  const query = async (sql, values = []) => {
    const text = sql.trim();
    if (text === 'BEGIN') { snapshot = structuredClone(state); return { rows: [], rowCount: 0 }; }
    if (text === 'COMMIT') { snapshot = null; return { rows: [], rowCount: 0 }; }
    if (text === 'ROLLBACK') {
      if (snapshot) Object.assign(state, snapshot);
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'SELECT \"Id\" FROM \"Businesses\" ORDER BY \"Id\"') {
      return { rows: [...new Set(state.jobs.map((job) => job.BusinessId))].sort().map((Id) => ({ Id })) };
    }
    if (text.includes("SET \"Status\" = 'Failed'")) {
      const tenantId = currentTenantRlsBusinessId();
      if (!tenantId) throw new Error('tenant context required for expired lease update');
      const expired = state.jobs.filter((job) => job.BusinessId === tenantId && job.Status === 'Leased' && job.LeaseUntilUtc < values[0] && job.Attempts >= values[1]);
      for (const job of expired) { job.Status = 'Failed'; job.LeaseUntilUtc = null; }
      return { rows: [], rowCount: expired.length };
    }
    if (text.includes('WITH picked AS')) {
      const [at, leaseUntil, limit, maxAttempts] = values;
      const tenantId = currentTenantRlsBusinessId();
      if (!tenantId) throw new Error('tenant context required for outbox claim');
      const eligible = state.jobs.filter((job) => job.BusinessId === tenantId && job.Attempts < maxAttempts && (
        (job.Status === 'Pending' && job.NextAttemptUtc <= at)
        || (job.Status === 'Leased' && job.LeaseUntilUtc < at))).slice(0, limit);
      for (const job of eligible) { job.Status = 'Leased'; job.LeaseUntilUtc = leaseUntil; job.Attempts += 1; }
      return { rows: eligible.map(({ Id, BusinessId, Attempts, LeaseUntilUtc }) => ({ Id, BusinessId, Attempts, LeaseUntilUtc })) };
    }
    if (text.includes('SELECT * FROM "NotificationOutbox"')) {
      const tenantId = currentTenantRlsBusinessId();
      if (!tenantId) throw new Error('tenant context required for processing read');
      return { rows: state.jobs.filter((job) => job.BusinessId === tenantId && job.Id === values[0] && job.Status === 'Leased'
        && job.LeaseUntilUtc.getTime() === values[1].getTime()) };
    }
    if (text.includes('FROM "Appointments"')) return { rows: state.appointment ? [state.appointment] : [] };
    if (text.includes('INSERT INTO "Notifications"')) {
      if (shouldFailNotifications) throw new Error('injected write failure');
      const exists = state.notifications.some((row) => row[1] === values[1] && row[2] === values[2] && row[9] === values[9]);
      if (!exists) state.notifications.push(values);
      return { rows: [], rowCount: exists ? 0 : 1 };
    }
    if (text.includes('UPDATE "NotificationOutbox" SET "Status" = \'Sent\'')) {
      const tenantId = currentTenantRlsBusinessId();
      if (!tenantId) throw new Error('tenant context required for sent update');
      const job = state.jobs.find((row) => row.BusinessId === tenantId && row.Id === values[0] && row.Status === values[1]);
      if (job) { job.Status = 'Sent'; job.LeaseUntilUtc = null; job.SentAtUtc = values[2]; job.EmailTextBody = ''; }
      return { rows: [], rowCount: job ? 1 : 0 };
    }
    if (text.includes('UPDATE "NotificationOutbox" SET "Status" = $3')) {
      const tenantId = currentTenantRlsBusinessId();
      if (!tenantId) throw new Error('tenant context required for retry update');
      const job = state.jobs.find((row) => row.BusinessId === tenantId && row.Id === values[0] && row.Status === 'Leased'
        && row.LeaseUntilUtc.getTime() === values[1].getTime());
      if (job) { job.Status = values[2]; job.LeaseUntilUtc = null; job.NextAttemptUtc = values[3]; job.LastError = values[4]; }
      return { rows: [], rowCount: job ? 1 : 0 };
    }
    throw new Error(`Unexpected outbox query: ${text}`);
  };
  const pool = { state, query, connect: async () => ({ query, release() {} }), setFailNotifications: (value) => { shouldFailNotifications = value; } };
  return pool;
}

describe('notification outbox worker', () => {
  it('retries a failed channel write and delivers the durable intent exactly once', async () => {
    const pool = fakePool({ failNotifications: true });
    const first = await dispatchNotificationOutboxOnce(pool, { now, log: {} });
    assert.deepEqual(first, { claimed: 1, sent: 0, retried: 1, failed: 0 });
    assert.equal(pool.state.jobs[0].Status, 'Pending');
    assert.equal(pool.state.jobs[0].Attempts, 1);
    assert.equal(pool.state.jobs[0].NextAttemptUtc.toISOString(), '2026-10-20T12:00:30.000Z');
    assert.equal(pool.state.notifications.length, 0);

    pool.setFailNotifications(false);
    const second = await dispatchNotificationOutboxOnce(pool, { now: new Date(now.getTime() + 30_000), log: {} });
    assert.deepEqual(second, { claimed: 1, sent: 1, retried: 0, failed: 0 });
    assert.equal(pool.state.jobs[0].Status, 'Sent');
    assert.equal(pool.state.notifications.length, 1);

    const third = await dispatchNotificationOutboxOnce(pool, { now: new Date(now.getTime() + 60_000), log: {} });
    assert.deepEqual(third, { claimed: 0, sent: 0, retried: 0, failed: 0 });
    assert.equal(pool.state.notifications.length, 1);
  });

  it('marks a lease that expired on its final attempt as failed', async () => {
    const expiredAt = new Date(now.getTime() - 1000);
    const pool = fakePool({ initial: { Status: 'Leased', Attempts: 6, LeaseUntilUtc: expiredAt } });
    const result = await dispatchNotificationOutboxOnce(pool, { now, log: {} });
    assert.deepEqual(result, { claimed: 0, sent: 0, retried: 0, failed: 1 });
    assert.equal(pool.state.jobs[0].Status, 'Failed');
  });

  it('suppresses appointment notifications retried after the appointment is cancelled or starts', async () => {
    for (const appointment of [
    { Status: 'Cancelled', StartUtc: new Date(now.getTime() + 60_000) },
    { Status: 'Scheduled', StartUtc: new Date(now.getTime() - 1_000) },
    null,
    ]) {
    const pool = fakePool({
      initial: { TargetKind: 'appointment', TargetId: '44444444-5555-4666-8777-888888888888' },
      appointment,
    });
    const result = await dispatchNotificationOutboxOnce(pool, { now, log: {} });
    assert.deepEqual(result, { claimed: 1, sent: 1, retried: 0, failed: 0 });
    assert.equal(pool.state.jobs[0].Status, 'Sent');
    assert.equal(pool.state.notifications.length, 0);
    }
  });

  it('suppresses a delayed appointment outbox item after the appointment start changes', async () => {
    const oldStart = new Date(now.getTime() + 60 * 60_000);
    const newStart = new Date(now.getTime() + 2 * 60 * 60_000);
    const appointmentId = '44444444-5555-4666-8777-888888888888';
    const pool = fakePool({
      initial: {
        TargetKind: 'appointment', TargetId: appointmentId,
        DeduplicationKey: `appointment.reminder:${appointmentId}:${oldStart.toISOString()}:120`,
      },
      appointment: { Status: 'Scheduled', StartUtc: newStart },
    });
    const result = await dispatchNotificationOutboxOnce(pool, { now, log: {} });
    assert.deepEqual(result, { claimed: 1, sent: 1, retried: 0, failed: 0 });
    assert.equal(pool.state.jobs[0].Status, 'Sent');
    assert.equal(pool.state.notifications.length, 0);
  });

  it('claims jobs under each business context without mixing tenants', async () => {
    const businessA = '11111111-2222-4333-8444-555555555555';
    const businessB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const otherJobId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const pool = fakePool({ additionalJobs: [{
      Id: otherJobId, BusinessId: businessB,
      RecipientMembershipId: 'cccccccc-dddd-4eee-8fff-000000000000',
      Category: 'tasks', EventType: 'task.assigned', Title: 'Other tenant task', Body: 'Other tenant body',
      TargetKind: 'task', TargetId: 'dddddddd-eeee-4fff-8000-111111111111', DeduplicationKey: 'task.assigned:other',
      InAppEnabled: true, EmailToAddress: null, EmailSubject: null, EmailTemplateKey: null, EmailTextBody: null,
      EmailDeduplicationKey: null, EmailNextAttemptUtc: null, Status: 'Pending', Attempts: 0,
      NextAttemptUtc: now, LeaseUntilUtc: null, CreatedAtUtc: now,
    }] });
    const result = await dispatchNotificationOutboxOnce(pool, { now, log: {} });
    assert.deepEqual(result, { claimed: 2, sent: 2, retried: 0, failed: 0 });
    assert.equal(pool.state.jobs.find((job) => job.BusinessId === businessA).Status, 'Sent');
    assert.equal(pool.state.jobs.find((job) => job.BusinessId === businessB).Status, 'Sent');
    assert.notEqual(businessA, businessB);
  });

});