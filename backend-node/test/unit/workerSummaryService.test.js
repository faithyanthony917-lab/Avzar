import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueDueWorkerSummaryJobs, runWorkerSummaryCycle, startWorkerSummaryWorker, workerSummaryContent,
} from '../../src/notifications/workerSummaryService.js';

const businessId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const membershipId = '11111111-2222-4333-8444-555555555555';
const taskId = '22222222-3333-4444-8555-666666666666';
const eventId = '33333333-4444-4555-8666-777777777777';
const jobId = '44444444-5555-4666-8777-888888888888';
const now = new Date('2026-10-21T18:00:00.000Z');

function fakePool({ failNotifications = false } = {}) {
  const state = { jobs: [], events: [], notifications: [], emails: [], outbox: [], queries: [] };
  const candidate = {
    BusinessId: businessId, MembershipId: membershipId, SummaryType: 'end_of_day', SummaryDate: '2026-10-21',
    ScheduledAtUtc: new Date('2026-10-21T17:00:00.000Z'), WindowStartUtc: new Date('2026-10-21T00:00:00.000Z'),
    WindowEndUtc: new Date('2026-10-21T17:00:00.000Z'),
  };
  const event = { Id: eventId, TaskId: taskId, Type: 'completed', CreatedAtUtc: new Date('2026-10-21T16:00:00.000Z') };
  const query = async (sql, values = []) => {
    state.queries.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('WITH local_clock AS')) return { rows: [candidate] };
    if (sql.includes('INSERT INTO "WorkerSummaryJobs"')) {
      if (state.jobs.some((job) => job.BusinessId === values[1] && job.RecipientMembershipId === values[2]
        && job.SummaryType === values[3] && job.SummaryDate === values[4])) return { rows: [], rowCount: 0 };
      state.jobs.push({
        Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], SummaryType: values[3], SummaryDate: values[4],
        ScheduledAtUtc: values[5], WindowStartUtc: values[6], WindowEndUtc: values[7], Status: 'Pending', Attempts: 0,
        NextAttemptUtc: values[8], LeaseUntilUtc: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('WITH picked AS')) {
      const selected = state.jobs.filter((job) => job.Status === 'Pending' && job.NextAttemptUtc <= values[0]).slice(0, values[2]);
      for (const job of selected) { job.Status = 'Leased'; job.LeaseUntilUtc = values[1]; job.Attempts += 1; }
      return { rows: selected };
    }
    if (sql.includes('FROM "WorkerSummaryJobs"') && sql.includes("'Leased'") && sql.includes('FOR UPDATE')) {
      return { rows: state.jobs.some((job) => job.Id === values[0] && job.LeaseUntilUtc === values[1] && job.Status === 'Leased') ? [{ Id: values[0] }] : [] };
    }
    if (sql.includes('FROM "TaskEvents" evt')) return { rows: [event] };
    if (sql.includes("'LeaseExpired'")) {
      const expired = state.jobs.filter((job) => job.Status === 'Leased' && job.LeaseUntilUtc < values[0] && job.Attempts >= values[1]);
      for (const job of expired) { job.Status = 'Failed'; job.LeaseUntilUtc = null; }
      return { rows: [], rowCount: expired.length };
    }
    if (sql.includes('FROM "ProductionTasks" task') && sql.includes('AS "Open"')) return { rows: [{ Open: 3, DueToday: 0, Overdue: 0, Scheduled: 0 }] };
    if (sql.includes('INSERT INTO "WorkerSummaryEvents"')) {
      const unique = state.events.some((item) => item.BusinessId === values[0] && item.RecipientMembershipId === values[1]
        && item.SummaryType === values[2] && item.EventId === values[4]);
      if (unique) return { rows: [], rowCount: 0 };
      state.events.push({ BusinessId: values[0], RecipientMembershipId: values[1], SummaryType: values[2], JobId: values[3], EventId: values[4] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM "WorkerSummaryEvents"')) return { rows: state.events.filter((item) => item.JobId === values[0]).map(() => ({
      Id: event.Id, TaskId: event.TaskId, Type: event.Type, CreatedAtUtc: event.CreatedAtUtc,
    })) };
    if (sql.includes('FROM "Memberships" m') && sql.includes('NotificationPreferences')) return { rows: [{
      Id: membershipId, DisplayName: 'Worker', Email: 'worker@example.test', TimeZoneId: 'UTC', QuietHoursEnabled: false,
      InAppEnabled: true, EmailEnabled: true, PushEnabled: false,
    }] };
    if (sql.includes('INSERT INTO "NotificationOutbox"')) {
      const duplicate = state.outbox.some((job) => job.BusinessId === values[1] && job.RecipientMembershipId === values[2]
        && job.DeduplicationKey === values[9]);
      if (duplicate) return { rows: [], rowCount: 0 };
      const job = {
        Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
        Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
        InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
        EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
        Status: 'Pending', Attempts: 0, NextAttemptUtc: values[17], CreatedAtUtc: values[17],
      };
      state.outbox.push(job);
      return { rows: [job], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "Notifications"')) {
      if (failNotifications) throw new Error('boom');
      state.notifications.push(values); return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "EmailOutbox"')) { state.emails.push(values); return { rows: [], rowCount: 1 }; }
    if (sql.includes('SET "NextAttemptUtc" = $3')) {
      const job = state.outbox.find((item) => item.Id === values[0] && item.Status === 'Pending');
      if (job) { job.NextAttemptUtc = values[2]; job.LastError = values[1]; }
      return { rows: [], rowCount: job ? 1 : 0 };
    }
    if (sql.includes('UPDATE "NotificationOutbox"')) {
      const job = state.outbox.find((item) => item.Id === values[0] && item.Status === values[1]);
      if (job) { job.Status = 'Sent'; job.EmailTextBody = ''; }
      return { rows: [], rowCount: job ? 1 : 0 };
    }
    if (sql.includes('SET "Status" = $3')) {
      const job = state.jobs.find((item) => item.Id === values[0] && item.Status === 'Leased');
      if (job) { job.Status = values[2]; job.LeaseUntilUtc = null; job.NextAttemptUtc = values[3]; job.LastError = values[4]; }
      return { rows: [], rowCount: job ? 1 : 0 };
    }
    if (sql.includes("SET \"Status\" = 'Sent'")) {
      const job = state.jobs.find((item) => item.Id === values[0]);
      if (job) { job.Status = 'Sent'; job.LeaseUntilUtc = null; }
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected worker-summary query: ${sql}`);
  };
  const pool = { state, query };
  pool.connect = async () => ({ query, release() {} });
  return pool;
}

describe('worker summaries', () => {
  it('builds worker-facing summaries without customer or measurement details', () => {
    const morning = workerSummaryContent('morning', { open: 4, dueToday: 2, overdue: 1, scheduled: 3 });
    assert.equal(morning.title, 'Your morning production summary');
    assert.equal(morning.body, 'Open tasks: 4. Due today: 2. Overdue: 1. Scheduled today: 3.');

    const endOfDay = workerSummaryContent('end_of_day', {
      open: 2,
      events: [{ Type: 'completed' }, { Type: 'issue_reported' }, { Type: 'unblocked' }, { Type: 'updated' }],
    });
    assert.equal(endOfDay.body, 'Today: 1 completed, 1 blocked, 1 unblocked, and 1 other task updates. 2 tasks remain open.');
    assert.doesNotMatch(`${morning.body} ${endOfDay.body}`, /customer|measurement/i);
  });

  it('persists a summary, claims each TaskEvent UUID once, and sends only one notification on repeated cycles', async () => {
    const pool = fakePool();
    const first = await runWorkerSummaryCycle(pool, { now, log: {} });
    assert.deepEqual(first, { created: 1, claimed: 1, sent: 1, retried: 0, failed: 0 });
    assert.equal(pool.state.jobs[0].Status, 'Sent');
    assert.equal(pool.state.events.length, 1);
    assert.equal(pool.state.events[0].EventId, eventId);
    assert.equal(pool.state.notifications.length, 1);
    assert.equal(pool.state.notifications[0][4], 'worker-summary.end-of-day');
    assert.equal(pool.state.emails.length, 1);

    const second = await runWorkerSummaryCycle(pool, { now: new Date(now.getTime() + 60_000), log: {} });
    assert.deepEqual(second, { created: 0, claimed: 0, sent: 0, retried: 0, failed: 0 });
    assert.equal(pool.state.jobs.length, 1);
    assert.equal(pool.state.events.length, 1);
    assert.equal(pool.state.notifications.length, 1);
    assert.equal(pool.state.emails.length, 1);
  });
});
describe('worker summary delivery, retries and scheduling', () => {
  it('counts open tasks in the end-of-day body and keeps customer data out of the stored text', async () => {
    const pool = fakePool();
    await runWorkerSummaryCycle(pool, { now, log: {} });
    const body = pool.state.notifications[0][6];
    assert.match(body, /1 completed/);
    assert.match(body, /3 tasks remain open/);
    assert.doesNotMatch(body, /customer|measurement/i);
  });

  it('leaves a failed channel write in the durable notification outbox for its retry worker', async () => {
    const pool = fakePool({ failNotifications: true });
    const first = await runWorkerSummaryCycle(pool, { now, log: {} });
    assert.deepEqual(first, { created: 1, claimed: 1, sent: 1, retried: 0, failed: 0 });
    assert.equal(pool.state.jobs[0].Status, 'Sent');
    assert.equal(pool.state.outbox.length, 1);
    assert.equal(pool.state.outbox[0].Status, 'Pending');
    assert.ok(pool.state.outbox[0].NextAttemptUtc > now, 'the outbox retry is scheduled in the future');
    assert.equal(pool.state.outbox[0].LastError, 'Error');
    assert.equal(pool.state.notifications.length, 0);
  });

  it('marks a job Failed when its lease expired after the last allowed attempt', async () => {
    const pool = fakePool();
    pool.state.jobs.push({
      Id: jobId, BusinessId: businessId, RecipientMembershipId: membershipId, SummaryType: 'end_of_day', SummaryDate: '2026-10-21',
      Status: 'Leased', Attempts: 6, LeaseUntilUtc: new Date(now.getTime() - 60_000), NextAttemptUtc: new Date(now.getTime() - 3_600_000),
    });
    const result = await runWorkerSummaryCycle(pool, { now, log: {} });
    assert.equal(result.failed, 1);
    assert.equal(result.claimed, 0);
    assert.equal(pool.state.jobs[0].Status, 'Failed');
  });

  it('only queues a slot shortly after its time and never orders by a column the CTE does not have', async () => {
    const pool = fakePool();
    await enqueueDueWorkerSummaryJobs(pool, { now });
    const enqueue = pool.state.queries.find((item) => item.sql.includes('WITH local_clock AS'));
    assert.deepEqual(enqueue.values.slice(1), [500, 4], 'default batch limit and four-hour catch-up window');
    assert.match(enqueue.sql, /make_interval\(hours => \$3::int\)/);
    assert.match(enqueue.sql, /NOT EXISTS \(\s*SELECT 1 FROM "WorkerSummaryJobs" existing/, 'already-queued slots must not crowd out new ones');
    assert.doesNotMatch(enqueue.sql, /ORDER BY due\."ScheduledAtUtc"/);
    assert.doesNotMatch(enqueue.sql, /\b(user|local|event)\./i, 'no reserved or keyword-like table aliases');
  });

  it('does nothing when disabled and schedules, repeats and stops cleanly when enabled', async () => {
    await startWorkerSummaryWorker({ pool: null })();
    await startWorkerSummaryWorker({ pool: fakePool(), enabled: false })();

    const pool = fakePool();
    const timers = [];
    const cancelled = [];
    const stop = startWorkerSummaryWorker({
      pool, startupDelayMs: 5, pollSeconds: 20, log: {},
      schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      cancel: (id) => cancelled.push(id),
    });
    assert.equal(timers[0].ms, 5);
    timers[0].fn();
    for (let i = 0; i < 200 && timers.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.length, 2, 'the next cycle is scheduled after the first one finishes');
    assert.equal(timers[1].ms, 20_000);
    assert.equal(pool.state.jobs.length, 1);
    await stop();
    assert.deepEqual(cancelled, [2], 'stopping cancels the pending timer');
  });
});
