import { randomUUID } from 'node:crypto';
import { nextDelayMs } from '../email/retryPolicy.js';
import { notify } from './notificationService.js';
import { runWithTenantRlsContext, setTenantRlsContext } from '../db/tenantRlsContext.js';

export const APPOINTMENT_REMINDER_BATCH_SIZE = 100;
export const APPOINTMENT_REMINDER_MAX_ATTEMPTS = 6;
export const APPOINTMENT_REMINDER_LEASE_MS = 5 * 60_000;

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

function localTime(instant, timeZoneId) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZoneId, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23',
    }).format(instant);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23',
    }).format(instant);
  }
}

async function deliverReminder(pool, job, now, log) {
  return inTransaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT reminder."Id", reminder."BusinessId", reminder."AppointmentId", reminder."RecipientMembershipId",
        reminder."AppointmentStartUtc", reminder."OffsetMinutes", appointment."Type", appointment."TimeZoneId",
        appointment."Status" AS "AppointmentStatus", appointment."StartUtc" AS "CurrentStartUtc",
        appointment."AssignedMembershipId", membership."Status" AS "MembershipStatus", business."IsActive" AS "BusinessActive"
      FROM "AppointmentReminders" reminder
      JOIN "Appointments" appointment ON appointment."BusinessId" = reminder."BusinessId" AND appointment."Id" = reminder."AppointmentId"
      JOIN "Businesses" business ON business."Id" = reminder."BusinessId"
      JOIN "Memberships" membership ON membership."BusinessId" = reminder."BusinessId" AND membership."Id" = reminder."RecipientMembershipId"
      WHERE reminder."Id" = $1 AND reminder."BusinessId" = $3 AND reminder."Status" = 'Leased' AND reminder."LeaseUntilUtc" = $2
      FOR UPDATE OF reminder`, [job.Id, job.LeaseUntilUtc, job.BusinessId]);
    const reminder = rows[0];
    if (!reminder) return 'stale';

    const appointmentStart = new Date(reminder.CurrentStartUtc);
    const stillCurrent = new Date(reminder.AppointmentStartUtc).getTime() === appointmentStart.getTime();
    const deliverable = reminder.BusinessActive && reminder.AppointmentStatus === 'Scheduled'
      && reminder.MembershipStatus === 0
      && reminder.AssignedMembershipId === reminder.RecipientMembershipId
      && stillCurrent
      && appointmentStart > now;
    if (!deliverable) {
      await db.query(`UPDATE "AppointmentReminders" SET "Status" = 'Cancelled', "LeaseUntilUtc" = NULL, "CancelledAtUtc" = $3
        WHERE "BusinessId" = $1 AND "AppointmentId" = $2 AND "Status" IN ('Pending', 'Leased')`,
      [reminder.BusinessId, reminder.AppointmentId, now]);
      return 'cancelled';
    }

    const hours = reminder.OffsetMinutes / 60;
    const time = localTime(appointmentStart, reminder.TimeZoneId);
    await notify(db, {
      businessId: reminder.BusinessId,
      category: 'schedule',
      eventType: 'appointment.reminder',
      title: 'Appointment reminder',
      body: `${reminder.Type} appointment in ${hours} hours: ${time}.`,
      dedupeKey: `appointment.reminder:${reminder.AppointmentId}:${appointmentStart.toISOString()}:${reminder.OffsetMinutes}`,
      target: { kind: 'appointment', id: reminder.AppointmentId },
      recipients: { membershipIds: [reminder.RecipientMembershipId] },
    }, { now, log });
    await db.query(`UPDATE "AppointmentReminders" SET "Status" = 'Sent', "LeaseUntilUtc" = NULL, "SentAtUtc" = $2
      WHERE "Id" = $1 AND "BusinessId" = $3 AND "Status" = 'Leased'`, [job.Id, now, job.BusinessId]);
    return 'sent';
  });
}

async function retryReminder(pool, job, error, { now, maxAttempts }) {
  const failed = job.Attempts >= maxAttempts;
  await pool.query(`
    UPDATE "AppointmentReminders" SET "Status" = $3, "LeaseUntilUtc" = NULL,
      "NextAttemptUtc" = $4, "LastError" = $5
    WHERE "Id" = $1 AND "BusinessId" = $6 AND "Status" = 'Leased' AND "LeaseUntilUtc" = $2`,
  [job.Id, job.LeaseUntilUtc, failed ? 'Failed' : 'Pending',
    new Date(now.getTime() + nextDelayMs(job.Attempts)), error?.constructor?.name ?? 'Error', job.BusinessId]);
  return failed ? 'failed' : 'retried';
}

export async function dispatchAppointmentRemindersOnce(pool, {
  now = new Date(), batchLimit = APPOINTMENT_REMINDER_BATCH_SIZE,
  leaseMs = APPOINTMENT_REMINDER_LEASE_MS, maxAttempts = APPOINTMENT_REMINDER_MAX_ATTEMPTS,
  log = console, clock = () => new Date(),
} = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const limit = Math.max(1, Math.min(1000, Math.trunc(batchLimit) || APPOINTMENT_REMINDER_BATCH_SIZE));
  // Businesses is the tenant directory. Only enumerate IDs globally; all reminder and
  // appointment reads/writes below execute with one transaction-local tenant context.
  const { rows: businesses } = await pool.query('SELECT "Id" FROM "Businesses" ORDER BY "Id"');
  const result = { claimed: 0, sent: 0, cancelled: 0, stale: 0, retried: 0, failed: 0 };
  const leaseUntil = new Date(now.getTime() + Math.max(10_000, leaseMs));

  for (const business of businesses) {
    if (result.claimed >= limit) break;
    await runWithTenantRlsContext(async () => {
      setTenantRlsContext(business.Id);
      const abandoned = await pool.query(`
        UPDATE "AppointmentReminders" SET "Status" = 'Failed', "LeaseUntilUtc" = NULL, "LastError" = 'LeaseExpired'
        WHERE "BusinessId" = $3 AND "Status" = 'Leased' AND "LeaseUntilUtc" < $1 AND "Attempts" >= $2`, [now, maxAttempts, business.Id]);
      result.failed += abandoned.rowCount ?? 0;
      await pool.query(`
        UPDATE "AppointmentReminders" reminder SET "Status" = 'Cancelled', "LeaseUntilUtc" = NULL, "CancelledAtUtc" = $1
        FROM "Appointments" appointment
        WHERE appointment."BusinessId" = reminder."BusinessId" AND appointment."Id" = reminder."AppointmentId"
          AND reminder."Status" IN ('Pending', 'Leased') AND appointment."StartUtc" <= $1
          AND reminder."BusinessId" = $2`, [now, business.Id]);

      const { rows: jobs } = await pool.query(`
        WITH picked AS (
          SELECT reminder."Id" FROM "AppointmentReminders" reminder
          JOIN "Appointments" appointment ON appointment."BusinessId" = reminder."BusinessId" AND appointment."Id" = reminder."AppointmentId"
          WHERE reminder."BusinessId" = $5 AND reminder."Attempts" < $4 AND reminder."DueAtUtc" <= $1 AND appointment."StartUtc" > $1 AND (
            (reminder."Status" = 'Pending' AND reminder."NextAttemptUtc" <= $1)
            OR (reminder."Status" = 'Leased' AND reminder."LeaseUntilUtc" < $1)
          )
          ORDER BY reminder."DueAtUtc", reminder."Id"
          LIMIT $3 FOR UPDATE OF reminder SKIP LOCKED
        )
        UPDATE "AppointmentReminders" reminder SET "Status" = 'Leased', "LeaseUntilUtc" = $2,
          "Attempts" = reminder."Attempts" + 1
        FROM picked WHERE reminder."Id" = picked."Id"
        RETURNING reminder."Id", reminder."BusinessId", reminder."Attempts", reminder."LeaseUntilUtc"`,
      [now, leaseUntil, limit - result.claimed, maxAttempts, business.Id]);
      result.claimed += jobs.length;

      for (const job of jobs) {
        if (String(job.BusinessId).toLowerCase() !== String(business.Id).toLowerCase()) {
          throw new Error('AppointmentReminderTenantMismatch');
        }
        try {
          const outcome = await deliverReminder(pool, job, clock(), log);
          if (outcome === 'sent' || outcome === 'cancelled' || outcome === 'stale') result[outcome] += 1;
        } catch (error) {
          const outcome = await retryReminder(pool, job, error, { now, maxAttempts });
          result[outcome] += 1;
          log.error?.('Appointment reminder failed; it will retry.', { reminderId: job.Id, errorType: error?.constructor?.name ?? 'Error' });
        }
      }
    });
  }
  return result;
}

export function startAppointmentReminderWorker({ pool, enabled = true, pollSeconds = 30, startupDelayMs = 30_000,
  log = console, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!pool || !enabled) return async () => {};
  let stopped = false;
  let timer = null;
  let running = null;

  const cycle = async () => {
    if (stopped) return;
    running = dispatchAppointmentRemindersOnce(pool, { log });
    try {
      const result = await running;
      if (result.claimed || result.cancelled || result.retried || result.failed) log.info?.('Appointment reminder cycle completed.', result);
    } catch (error) {
      log.error?.('Appointment reminder cycle failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error' });
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