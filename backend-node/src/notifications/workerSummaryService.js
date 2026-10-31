import { randomUUID } from 'node:crypto';
import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { notify } from './notificationService.js';

export const WORKER_SUMMARY_TIMES = Object.freeze({ morning: '08:00', end_of_day: '17:00' });
export const WORKER_SUMMARY_MAX_ATTEMPTS = 6;
export const WORKER_SUMMARY_BATCH_SIZE = 100;
export const WORKER_SUMMARY_LEASE_MS = 5 * 60_000;
// A summary is only worth sending close to its slot. After an outage or a first deploy, a slot older than this is skipped
// rather than delivering a "morning" summary in the evening.
export const WORKER_SUMMARY_CATCHUP_HOURS = 4;

const RETRY_DELAYS_MS = [30_000, 120_000, 8 * 60_000, 32 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
const OPEN_TASK_STATUSES = ['Pending', 'Scheduled', 'InProgress', 'Paused', 'Blocked'];

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueDueWorkerSummaryJobs(pool, { now = new Date(), batchLimit = 500, catchupHours = WORKER_SUMMARY_CATCHUP_HOURS } = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const limit = Math.max(1, Math.min(5000, Math.trunc(batchLimit) || 500));
  const catchup = Math.max(1, Math.min(6, Math.trunc(catchupHours) || WORKER_SUMMARY_CATCHUP_HOURS));
  return inTransaction(pool, async (db) => {
    const { rows: candidates } = await db.query(`
      WITH local_clock AS (
        SELECT business."Id" AS "BusinessId", business."TimeZoneId", member."Id" AS "MembershipId",
          member."UserId", (($1::timestamptz AT TIME ZONE business."TimeZoneId")::date) AS "SummaryDate",
          ($1::timestamptz AT TIME ZONE business."TimeZoneId") AS "LocalNow"
        FROM "Businesses" business
        JOIN "Memberships" member ON member."BusinessId" = business."Id" AND member."Status" = 0
        WHERE business."IsActive"
      ), slots AS (
        SELECT 'morning'::text AS "SummaryType", time '08:00' AS "LocalTime"
        UNION ALL
        SELECT 'end_of_day'::text, time '17:00'
      ), due AS (
        SELECT clock."BusinessId", clock."MembershipId", clock."UserId", clock."TimeZoneId", clock."SummaryDate",
          slot."SummaryType", slot."LocalTime", clock."SummaryDate"::timestamp AS "LocalStart",
          clock."SummaryDate"::timestamp + slot."LocalTime" AS "LocalEnd", clock."LocalNow"
        FROM local_clock clock CROSS JOIN slots slot
        WHERE clock."LocalNow"::time >= slot."LocalTime"
          AND clock."LocalNow"::time < slot."LocalTime" + make_interval(hours => $3::int)
      )
      SELECT due."BusinessId", due."MembershipId", due."SummaryType", due."SummaryDate",
        due."LocalStart" AT TIME ZONE due."TimeZoneId" AS "WindowStartUtc",
        due."LocalEnd" AT TIME ZONE due."TimeZoneId" AS "ScheduledAtUtc",
        due."LocalEnd" AT TIME ZONE due."TimeZoneId" AS "WindowEndUtc"
      FROM due
      WHERE NOT EXISTS (
        SELECT 1 FROM "WorkerSummaryJobs" existing
        WHERE existing."BusinessId" = due."BusinessId" AND existing."RecipientMembershipId" = due."MembershipId"
          AND existing."SummaryType" = due."SummaryType" AND existing."SummaryDate" = due."SummaryDate")
        AND (
          EXISTS (
            SELECT 1 FROM "ProductionTasks" task
            WHERE task."BusinessId" = due."BusinessId" AND task."AssignedMembershipId" = due."MembershipId"
              AND task."Status" NOT IN ('Completed', 'Cancelled'))
          OR (due."SummaryType" = 'end_of_day' AND EXISTS (
            SELECT 1 FROM "TaskEvents" evt
            JOIN "ProductionTasks" task ON task."BusinessId" = evt."BusinessId" AND task."Id" = evt."TaskId"
            WHERE evt."BusinessId" = due."BusinessId"
              AND evt."CreatedAtUtc" >= (due."LocalStart" AT TIME ZONE due."TimeZoneId")
              AND evt."CreatedAtUtc" < (due."LocalEnd" AT TIME ZONE due."TimeZoneId")
              AND (task."AssignedMembershipId" = due."MembershipId" OR evt."ActorUserId" = due."UserId"
                OR evt."DataJson"->>'before' = due."MembershipId"::text OR evt."DataJson"->>'after' = due."MembershipId"::text))))
      ORDER BY due."LocalEnd" AT TIME ZONE due."TimeZoneId", due."BusinessId", due."MembershipId", due."SummaryType"
      LIMIT $2`, [now, limit, catchup]);

    let queued = 0;
    for (const candidate of candidates) {
      const result = await db.query(`
        INSERT INTO "WorkerSummaryJobs" ("Id","BusinessId","RecipientMembershipId","SummaryType","SummaryDate",
          "ScheduledAtUtc","WindowStartUtc","WindowEndUtc","Status","Attempts","NextAttemptUtc","CreatedAtUtc")
        VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,'Pending',0,$9,$9)
        ON CONFLICT ("BusinessId","RecipientMembershipId","SummaryType","SummaryDate") DO NOTHING`,
      [randomUUID(), candidate.BusinessId, candidate.MembershipId, candidate.SummaryType, candidate.SummaryDate,
        candidate.ScheduledAtUtc, candidate.WindowStartUtc, candidate.WindowEndUtc, now]);
      queued += result.rowCount ?? 0;
    }
    return queued;
  });
}

export function workerSummaryContent(summaryType, { open = 0, dueToday = 0, overdue = 0, scheduled = 0, events = [] } = {}) {
  if (summaryType === 'morning') {
    return {
      title: 'Your morning production summary',
      body: `Open tasks: ${open}. Due today: ${dueToday}. Overdue: ${overdue}. Scheduled today: ${scheduled}.`,
    };
  }
  const completed = events.filter((event) => ['completed', 'override.complete'].includes(event.Type)).length;
  const blocked = events.filter((event) => event.Type === 'issue_reported').length;
  const unblocked = events.filter((event) => event.Type === 'unblocked').length;
  const other = Math.max(0, events.length - completed - blocked - unblocked);
  return {
    title: 'Your end-of-day production summary',
    body: `Today: ${completed} completed, ${blocked} blocked, ${unblocked} unblocked, and ${other} other task updates. ${open} tasks remain open.`,
  };
}

async function collectSummaryEvents(db, job) {
  // The morning summary reports counts only, so it has no events to de-duplicate.
  if (job.SummaryType !== 'end_of_day') return [];
  const { rows } = await db.query(`
    SELECT evt."Id", evt."TaskId", evt."Type", evt."CreatedAtUtc"
    FROM "TaskEvents" evt
    JOIN "ProductionTasks" task ON task."BusinessId" = evt."BusinessId" AND task."Id" = evt."TaskId"
    JOIN "Memberships" member ON member."BusinessId" = evt."BusinessId" AND member."Id" = $2 AND member."Status" = 0
    WHERE evt."BusinessId" = $1 AND evt."CreatedAtUtc" >= $3 AND evt."CreatedAtUtc" < $4
      AND (task."AssignedMembershipId" = member."Id" OR evt."ActorUserId" = member."UserId"
        OR evt."DataJson"->>'before' = member."Id"::text OR evt."DataJson"->>'after' = member."Id"::text)
    ORDER BY evt."CreatedAtUtc", evt."Id"`,
  [job.BusinessId, job.RecipientMembershipId, job.WindowStartUtc, job.WindowEndUtc]);

  for (const event of rows) {
    await db.query(`
      INSERT INTO "WorkerSummaryEvents" ("BusinessId","RecipientMembershipId","SummaryType","SummaryJobId","EventId","TaskId","EventType","EventAtUtc")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ("BusinessId","RecipientMembershipId","SummaryType","EventId") DO NOTHING`,
    [job.BusinessId, job.RecipientMembershipId, job.SummaryType, job.Id, event.Id, event.TaskId, event.Type, event.CreatedAtUtc]);
  }

  const { rows: persisted } = await db.query(`
    SELECT "EventId" AS "Id", "TaskId", "EventType" AS "Type", "EventAtUtc" AS "CreatedAtUtc"
    FROM "WorkerSummaryEvents"
    WHERE "SummaryJobId" = $1 AND "BusinessId" = $2 AND "RecipientMembershipId" = $3 AND "SummaryType" = $4
    ORDER BY "EventAtUtc", "EventId"`, [job.Id, job.BusinessId, job.RecipientMembershipId, job.SummaryType]);
  return persisted;
}

async function taskCounts(db, job) {
  const { rows } = await db.query(`
    SELECT count(*) FILTER (WHERE task."Status" = ANY($3::varchar[]))::int AS "Open",
      count(*) FILTER (WHERE task."Status" = ANY($3::varchar[]) AND task."DeadlineUtc" IS NOT NULL
        AND (task."DeadlineUtc" AT TIME ZONE business."TimeZoneId")::date = $4::date)::int AS "DueToday",
      count(*) FILTER (WHERE task."Status" = ANY($3::varchar[]) AND task."DeadlineUtc" IS NOT NULL
        AND (task."DeadlineUtc" AT TIME ZONE business."TimeZoneId")::date < $4::date)::int AS "Overdue",
      count(*) FILTER (WHERE task."Status" = ANY($3::varchar[]) AND task."PlannedStartUtc" IS NOT NULL
        AND (task."PlannedStartUtc" AT TIME ZONE business."TimeZoneId")::date = $4::date)::int AS "Scheduled"
    FROM "ProductionTasks" task
    JOIN "Businesses" business ON business."Id" = task."BusinessId"
    WHERE task."BusinessId" = $1 AND task."AssignedMembershipId" = $2`,
  [job.BusinessId, job.RecipientMembershipId, OPEN_TASK_STATUSES, job.SummaryDate]);
  const row = rows[0] ?? {};
  return { open: row.Open ?? 0, dueToday: row.DueToday ?? 0, overdue: row.Overdue ?? 0, scheduled: row.Scheduled ?? 0 };
}

async function processWorkerSummaryJob(pool, job, { now, log }) {
  return inTransaction(pool, async (db) => {
    const { rows: locked } = await db.query(`
      SELECT "Id" FROM "WorkerSummaryJobs"
      WHERE "Id" = $1 AND "Status" = 'Leased' AND "LeaseUntilUtc" = $2
      FOR UPDATE`, [job.Id, job.LeaseUntilUtc]);
    if (!locked.length) return false;

    const events = await collectSummaryEvents(db, job);
    const counts = await taskCounts(db, job);
    const summary = workerSummaryContent(job.SummaryType, { ...counts, events });
    const eventLabel = job.SummaryType === 'morning' ? 'worker-summary.morning' : 'worker-summary.end-of-day';
    const result = await notify(db, {
      businessId: job.BusinessId, category: 'tasks', eventType: eventLabel,
      title: summary.title, body: summary.body, dedupeKey: `worker-summary:${job.Id}`,
      recipients: { membershipIds: [job.RecipientMembershipId] },
      email: {
        templateKey: eventLabel, subject: summary.title,
        text: () => `${summary.body}\n\nOpen Avzar to review your production tasks.`,
      },
    }, { now, log });
    if (!result.ok) throw new Error('NotificationWriteFailed');

    await db.query(`
      UPDATE "WorkerSummaryJobs" SET "Status" = 'Sent', "LeaseUntilUtc" = NULL, "SentAtUtc" = $3, "LastError" = NULL
      WHERE "Id" = $1 AND "Status" = 'Leased' AND "LeaseUntilUtc" = $2`, [job.Id, job.LeaseUntilUtc, now]);
    return true;
  });
}

async function retryWorkerSummaryJob(pool, job, error, { now, maxAttempts }) {
  const failed = job.Attempts >= maxAttempts;
  const delay = RETRY_DELAYS_MS[Math.min(job.Attempts - 1, RETRY_DELAYS_MS.length - 1)];
  await pool.query(`
    UPDATE "WorkerSummaryJobs" SET "Status" = $3, "LeaseUntilUtc" = NULL,
      "NextAttemptUtc" = $4, "LastError" = $5
    WHERE "Id" = $1 AND "Status" = 'Leased' AND "LeaseUntilUtc" = $2`,
  [job.Id, job.LeaseUntilUtc, failed ? 'Failed' : 'Pending', new Date(now.getTime() + delay), error?.constructor?.name ?? 'Error']);
  return failed ? 'failed' : 'retried';
}

export async function runWorkerSummaryCycle(pool, { now = new Date(), batchLimit = WORKER_SUMMARY_BATCH_SIZE,
  leaseMs = WORKER_SUMMARY_LEASE_MS, maxAttempts = WORKER_SUMMARY_MAX_ATTEMPTS, log = console } = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const created = await enqueueDueWorkerSummaryJobs(pool, { now });
  // A job whose lease expired after its last allowed attempt (for example the process died mid-send) must end as Failed,
  // otherwise it would be claimed again forever.
  const abandoned = await pool.query(`
    UPDATE "WorkerSummaryJobs" SET "Status" = 'Failed', "LeaseUntilUtc" = NULL, "LastError" = 'LeaseExpired'
    WHERE "Status" = 'Leased' AND "LeaseUntilUtc" < $1 AND "Attempts" >= $2`, [now, maxAttempts]);
  const limit = Math.max(1, Math.min(1000, Math.trunc(batchLimit) || WORKER_SUMMARY_BATCH_SIZE));
  const leaseUntil = new Date(now.getTime() + Math.max(10_000, leaseMs));
  const { rows: jobs } = await pool.query(`
    WITH picked AS (
      SELECT "Id" FROM "WorkerSummaryJobs"
      WHERE "Status" IN ('Pending', 'Leased') AND "NextAttemptUtc" <= $1
        AND ("LeaseUntilUtc" IS NULL OR "LeaseUntilUtc" < $1)
      ORDER BY "NextAttemptUtc", "ScheduledAtUtc", "Id"
      LIMIT $3 FOR UPDATE SKIP LOCKED
    )
    UPDATE "WorkerSummaryJobs" job SET "Status" = 'Leased', "LeaseUntilUtc" = $2, "Attempts" = job."Attempts" + 1
    FROM picked WHERE job."Id" = picked."Id"
    RETURNING job."Id", job."BusinessId", job."RecipientMembershipId", job."SummaryType", job."SummaryDate",
      job."WindowStartUtc", job."WindowEndUtc", job."LeaseUntilUtc", job."Attempts"`, [now, leaseUntil, limit]);

  const result = { created, claimed: jobs.length, sent: 0, retried: 0, failed: abandoned.rowCount ?? 0 };
  for (const job of jobs) {
    try {
      if (await processWorkerSummaryJob(pool, job, { now, log })) result.sent++;
    } catch (error) {
      const outcome = await retryWorkerSummaryJob(pool, job, error, { now, maxAttempts });
      result[outcome]++;
      log.error?.('Worker summary delivery failed; it will retry.', { jobId: job.Id, errorType: error?.constructor?.name ?? 'Error' });
    }
  }
  return result;
}

export function startWorkerSummaryWorker({ pool, enabled = true, pollSeconds = 60, startupDelayMs = 30_000,
  log = console, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!pool || !enabled) return async () => {};
  let stopped = false;
  let timer = null;
  let running = null;
  const cycle = async () => {
    if (stopped) return;
    running = forEachBusiness(pool, () => runWorkerSummaryCycle(pool, { log }), { log }).then(sumResults);
    try {
      const result = await running;
      if (result.created || result.sent || result.retried || result.failed) log.info?.('Worker summary cycle completed.', result);
    } catch (error) {
      log.error?.('Worker summary cycle failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error' });
    } finally { running = null; }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(15, pollSeconds) * 1000);
  };
  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0, startupDelayMs));
  return async () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    await running?.catch(() => {});
  };
}