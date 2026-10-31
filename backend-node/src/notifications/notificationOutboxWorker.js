import { nextDelayMs } from '../email/retryPolicy.js';
import { deliverNotificationOutboxJob } from './notificationService.js';
import { runWithTenantRlsContext, setTenantRlsContext } from '../db/tenantRlsContext.js';

export const NOTIFICATION_OUTBOX_MAX_ATTEMPTS = 6;
export const NOTIFICATION_OUTBOX_BATCH_SIZE = 100;
export const NOTIFICATION_OUTBOX_LEASE_MS = 5 * 60_000;

// Process-local round-robin cursor prevents a busy low-sorted tenant from monopolizing
// every bounded batch. Each invocation starts after the last tenant visited.
let lastVisitedBusinessId = null;

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

async function processJob(pool, job, now) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT * FROM "NotificationOutbox"
      WHERE "Id" = $1 AND "Status" = 'Leased' AND "LeaseUntilUtc" = $2
      FOR UPDATE`, [job.Id, job.LeaseUntilUtc]);
    if (!rows.length) return false;
        const current = rows[0];
        if (current.TargetKind === 'appointment' && current.TargetId) {
          const appointment = await db.query(`
            SELECT "Status", "StartUtc" FROM "Appointments"
            WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`, [current.BusinessId, current.TargetId]);
          const row = appointment.rows[0];
          const currentStartKey = row
            ? `appointment.reminder:${current.TargetId}:${new Date(row.StartUtc).toISOString()}:`
            : null;
          if (!row || row.Status !== 'Scheduled' || new Date(row.StartUtc) <= now) {
            const skipped = await db.query(`
              UPDATE "NotificationOutbox" SET "Status" = 'Sent', "LeaseUntilUtc" = NULL,
                "SentAtUtc" = $3, "LastError" = NULL,
                "EmailTextBody" = CASE WHEN "EmailToAddress" IS NULL THEN NULL ELSE '' END
              WHERE "Id" = $1 AND "Status" = $2`, [current.Id, 'Leased', now]);
            if ((skipped.rowCount ?? 0) !== 1) throw new Error('NotificationOutboxStateChanged');
            return true;
          }
          if (!current.DeduplicationKey.startsWith(currentStartKey)) {
            const skipped = await db.query(`
              UPDATE "NotificationOutbox" SET "Status" = 'Sent', "LeaseUntilUtc" = NULL,
                "SentAtUtc" = $3, "LastError" = NULL,
                "EmailTextBody" = CASE WHEN "EmailToAddress" IS NULL THEN NULL ELSE '' END
              WHERE "Id" = $1 AND "Status" = $2`, [current.Id, 'Leased', now]);
            if ((skipped.rowCount ?? 0) !== 1) throw new Error('NotificationOutboxStateChanged');
            return true;
          }
        }
        await deliverNotificationOutboxJob(db, current, { now, expectedStatus: 'Leased' });
    return true;
  });
}

async function retryJob(pool, job, error, { now, maxAttempts }) {
  const failed = job.Attempts >= maxAttempts;
  const nextAttempt = new Date(now.getTime() + nextDelayMs(job.Attempts));
  await pool.query(`
    UPDATE "NotificationOutbox" SET "Status" = $3, "LeaseUntilUtc" = NULL,
      "NextAttemptUtc" = $4, "LastError" = $5
    WHERE "Id" = $1 AND "Status" = 'Leased' AND "LeaseUntilUtc" = $2`,
  [job.Id, job.LeaseUntilUtc, failed ? 'Failed' : 'Pending', nextAttempt, error?.constructor?.name ?? 'Error']);
  return failed ? 'failed' : 'retried';
}

export async function dispatchNotificationOutboxOnce(pool, {
  now = new Date(), batchLimit = NOTIFICATION_OUTBOX_BATCH_SIZE,
  leaseMs = NOTIFICATION_OUTBOX_LEASE_MS, maxAttempts = NOTIFICATION_OUTBOX_MAX_ATTEMPTS,
  log = console,
} = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const limit = Math.max(1, Math.min(1000, Math.trunc(batchLimit) || NOTIFICATION_OUTBOX_BATCH_SIZE));

  // Businesses has no BusinessId column and is deliberately outside the legacy tenant
  // policy loop. Enumerate IDs only; all outbox reads and writes happen with that tenant set.
  const { rows: businesses } = await pool.query('SELECT "Id" FROM "Businesses" ORDER BY "Id"');
  const result = { claimed: 0, sent: 0, retried: 0, failed: 0 };
  if (businesses.length && lastVisitedBusinessId !== null) {
    const nextIndex = businesses.findIndex(({ Id }) => Id > lastVisitedBusinessId);
    const startIndex = nextIndex < 0 ? 0 : nextIndex;
    businesses.push(...businesses.splice(0, startIndex));
  }
  const leaseUntil = new Date(now.getTime() + Math.max(10_000, leaseMs));

  for (const business of businesses) {
    if (result.claimed >= limit) break;
    lastVisitedBusinessId = business.Id;
    await runWithTenantRlsContext(async () => {
      setTenantRlsContext(business.Id);
      const abandoned = await pool.query(`
        UPDATE "NotificationOutbox" SET "Status" = 'Failed', "LeaseUntilUtc" = NULL, "LastError" = 'LeaseExpired'
        WHERE "BusinessId" = $3 AND "Status" = 'Leased' AND "LeaseUntilUtc" < $1 AND "Attempts" >= $2`,
      [now, maxAttempts, business.Id]);
      result.failed += abandoned.rowCount ?? 0;

      const { rows: jobs } = await pool.query(`
        WITH picked AS (
          SELECT "Id" FROM "NotificationOutbox"
          WHERE "BusinessId" = $5 AND "Attempts" < $4 AND (
            ("Status" = 'Pending' AND "NextAttemptUtc" <= $1)
            OR ("Status" = 'Leased' AND "LeaseUntilUtc" < $1))
          ORDER BY "NextAttemptUtc", "CreatedAtUtc", "Id"
          LIMIT $3 FOR UPDATE SKIP LOCKED
        )
        UPDATE "NotificationOutbox" job SET "Status" = 'Leased', "LeaseUntilUtc" = $2,
          "Attempts" = job."Attempts" + 1
        FROM picked WHERE job."Id" = picked."Id"
        RETURNING job."Id", job."BusinessId", job."Attempts", job."LeaseUntilUtc"`,
      [now, leaseUntil, limit - result.claimed, maxAttempts, business.Id]);
      result.claimed += jobs.length;

      for (const job of jobs) {
        // Defensive consistency check: never process a claimed job under a different tenant.
        if (String(job.BusinessId).toLowerCase() !== String(business.Id).toLowerCase()) {
          throw new Error('NotificationOutboxTenantMismatch');
        }
        try {
          if (await processJob(pool, job, now)) result.sent += 1;
        } catch (error) {
          const outcome = await retryJob(pool, job, error, { now, maxAttempts });
          result[outcome] += 1;
          log.error?.('Notification outbox delivery failed; it will retry.', {
            jobId: job.Id, errorType: error?.constructor?.name ?? 'Error',
          });
        }
      }
    });
  }
  return result;
}

export function startNotificationOutboxWorker({ pool, enabled = true, pollSeconds = 10, startupDelayMs = 30_000,
  log = console, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!pool || !enabled) return async () => {};
  let stopped = false;
  let timer = null;
  let running = null;

  const cycle = async () => {
    if (stopped) return;
    running = dispatchNotificationOutboxOnce(pool, { log });
    try {
      const result = await running;
      if (result.claimed || result.retried || result.failed) log.info?.('Notification outbox cycle completed.', result);
    } catch (error) {
      log.error?.('Notification outbox cycle failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error' });
    } finally { running = null; }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(1, pollSeconds) * 1000);
  };

  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0, startupDelayMs));
  return async () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    await running?.catch(() => {});
  };
}
