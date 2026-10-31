import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { notify } from '../notifications/notificationService.js';

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

export async function enqueueOverdueTaskReminders(pool, { now = new Date(), batchLimit = 500, log = console } = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const { rows } = await pool.query(`
    SELECT task."Id", task."BusinessId", task."Title", task."DeadlineUtc", task."AssignedMembershipId"
    FROM "ProductionTasks" task
    JOIN "Businesses" business ON business."Id" = task."BusinessId" AND business."IsActive"
    JOIN "Memberships" membership ON membership."Id" = task."AssignedMembershipId"
      AND membership."BusinessId" = task."BusinessId" AND membership."Status" = 0
    WHERE task."DeadlineUtc" IS NOT NULL AND task."DeadlineUtc" < $1
      AND task."Status" IN ('Pending', 'Scheduled', 'InProgress', 'Paused')
        AND NOT EXISTS (
          SELECT 1 FROM "Notifications" notification
          WHERE notification."BusinessId" = task."BusinessId"
            AND notification."RecipientMembershipId" = membership."Id"
            AND notification."DeduplicationKey" = 'task.overdue:' || replace(task."Id"::text, '-', '') || ':' || $2
        )
    ORDER BY task."DeadlineUtc", task."Id"
    LIMIT $3`, [now, day, Math.max(1, Math.min(5000, Math.trunc(batchLimit)))]);

  let queued = 0;
  for (const task of rows) {
    const taskId = String(task.Id).replaceAll('-', '').toLowerCase();
    const deduplicationKey = `task.overdue:${taskId}:${day}`;
    const deadline = new Date(task.DeadlineUtc);
    const deadlineLabel = `${deadline.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const result = await inTransaction(pool, (client) => notify(client, {
      businessId: task.BusinessId, category: 'tasks', eventType: 'task.overdue', title: 'Task overdue',
      body: 'A production task is overdue.', dedupeKey: deduplicationKey,
      target: { kind: 'task', id: task.Id }, recipients: { membershipIds: [task.AssignedMembershipId] },
      email: {
        templateKey: 'task.overdue', subject: 'A production task is overdue',
        text: (recipient) => `Hello ${String(recipient.DisplayName ?? '')},\n\nA production task is overdue (deadline: ${deadlineLabel}). Please open Avzar to review its status and next steps.`,
        dedupeKey: () => deduplicationKey,
      },
    }, { now, log }));
    if (result.inApp || result.email) queued += 1;
  }
  return queued;
}

export function startOverdueTaskReminderWorker({ pool, enabled = true, pollSeconds = 900, log = console, schedule = setTimeout, cancel = clearTimeout }) {
  if (!pool || !enabled) return async () => {};
  let stopped = false;
  let timer = null;
  let running = null;

  const cycle = async () => {
    if (stopped) return;
    running = forEachBusiness(pool, () => enqueueOverdueTaskReminders(pool, { log }), { log }).then(sumResults);
    try {
      const queued = await running;
      if (queued) log.info?.('Queued overdue task reminder emails.', { count: queued });
    } catch (error) {
      log.error?.('Overdue task reminder cycle failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error' });
    } finally {
      running = null;
    }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, pollSeconds * 1000);
  };

  void cycle();
  return async () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    await running?.catch(() => {});
  };
}