import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { notify, purgeOldNotifications } from './notificationService.js';
import { enqueueStaffSweep } from './staffSweeps.js';

const clampBatch = (value) => Math.max(1, Math.min(5000, Math.trunc(value) || 500));
const compactId = (value) => String(value).replaceAll('-', '').toLowerCase();

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

export async function enqueueNotificationSweep(pool, { now = new Date(), batchLimit = 500, log = console } = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const limit = clampBatch(batchLimit);
  const dueSoonUntil = new Date(now.getTime() + 24 * 60 * 60_000);
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const results = { dueSoon: 0, deliveryAtRisk: 0, quotationReminders: 0, overdueInvoices: 0, purged: 0 };

  const dueSoon = await pool.query(`
    SELECT task."Id", task."BusinessId", task."Title", task."DeadlineUtc", task."AssignedMembershipId"
    FROM "ProductionTasks" task
    JOIN "Businesses" business ON business."Id" = task."BusinessId" AND business."IsActive"
    JOIN "Memberships" member ON member."Id" = task."AssignedMembershipId"
      AND member."BusinessId" = task."BusinessId" AND member."Status" = 0
    WHERE task."DeadlineUtc" > $1 AND task."DeadlineUtc" <= $2
      AND task."Status" IN ('Pending', 'Scheduled', 'InProgress', 'Paused')
      AND NOT EXISTS (
        SELECT 1 FROM "Notifications" notification
        WHERE notification."BusinessId" = task."BusinessId"
          AND notification."RecipientMembershipId" = member."Id" AND notification."TargetId" = task."Id"
          AND notification."EventType" = 'task.due-soon'
          AND notification."CreatedAtUtc" >= task."DeadlineUtc" - interval '24 hours')
    ORDER BY task."DeadlineUtc", task."Id" LIMIT $3`, [now, dueSoonUntil, limit]);
  for (const task of dueSoon.rows) {
    const dedupeKey = `task.due-soon:${compactId(task.Id)}:${new Date(task.DeadlineUtc).toISOString()}`;
    const result = await inTransaction(pool, (client) => notify(client, {
      businessId: task.BusinessId, category: 'tasks', eventType: 'task.due-soon', title: 'Task due soon',
      body: 'A production task is due within 24 hours.', dedupeKey,
      target: { kind: 'task', id: task.Id }, recipients: { membershipIds: [task.AssignedMembershipId] },
      email: {
        templateKey: 'task.due-soon', subject: 'A production task is due soon',
        text: (recipient) => `Hello ${String(recipient.DisplayName ?? '')},\n\nA production task is due within 24 hours. Please open Avzar to review the task details.`,
      },
    }, { now, log }));
    results.dueSoon += result.inApp;
  }

  const deliveryAtRisk = await pool.query(`
    SELECT orderRow."Id", orderRow."BusinessId", orderRow."OrderNumber", orderRow."LocationId"
    FROM "Orders" orderRow
    JOIN "Businesses" business ON business."Id" = orderRow."BusinessId" AND business."IsActive"
    WHERE orderRow."Status" NOT IN ('Ready', 'Delivered', 'Cancelled')
      AND orderRow."PromisedDate" <= ($2::timestamptz AT TIME ZONE business."TimeZoneId")::date + 3
      AND EXISTS (
        SELECT 1 FROM "ProductionTasks" task
        WHERE task."BusinessId" = orderRow."BusinessId" AND task."OrderId" = orderRow."Id"
          AND task."Status" NOT IN ('Completed', 'Cancelled')
          AND (task."Status" = 'Blocked' OR task."AssignedMembershipId" IS NULL OR task."DeadlineUtc" < $2::timestamptz))
      AND NOT EXISTS (
        SELECT 1 FROM "Notifications" notification
        WHERE notification."BusinessId" = orderRow."BusinessId" AND notification."TargetId" = orderRow."Id"
          AND notification."EventType" = 'order.delivery-at-risk' AND notification."CreatedAtUtc" >= $3::date)
    ORDER BY orderRow."PromisedDate", orderRow."Id" LIMIT $1`, [limit, now, day]);
  for (const order of deliveryAtRisk.rows) {
    const result = await inTransaction(pool, (client) => notify(client, {
      businessId: order.BusinessId, category: 'orders', eventType: 'order.delivery-at-risk', title: 'Delivery at risk',
      body: `Order ${order.OrderNumber} may miss its promised delivery date.`,
      dedupeKey: `order.at-risk:${compactId(order.Id)}:${day}`,
      target: { kind: 'order', id: order.Id }, recipients: { permission: 'orders.manage', locationId: order.LocationId },
      email: {
        templateKey: 'order.delivery-at-risk', subject: 'A delivery may be at risk',
        text: () => `Order ${order.OrderNumber} may miss its promised delivery date. Open Avzar to review production progress.`,
      },
    }, { now, log }));
    results.deliveryAtRisk += result.inApp;
  }

  const quotations = await pool.query(`
    SELECT orderRow."Id", orderRow."BusinessId", orderRow."LocationId", orderRow."QuotedAtUtc"
    FROM "Orders" orderRow
    WHERE orderRow."Status" = 'Quoted' AND orderRow."QuotedAtUtc" IS NOT NULL
      AND (
        SELECT max(sent."CreatedAtUtc") FROM "QuotationEvents" sent
        WHERE sent."BusinessId" = orderRow."BusinessId" AND sent."OrderId" = orderRow."Id"
          AND sent."QuotedAtUtc" = orderRow."QuotedAtUtc" AND sent."Type" = 'Sent')
        <= $1::timestamptz - interval '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM "QuotationEvents" answered
        WHERE answered."BusinessId" = orderRow."BusinessId" AND answered."OrderId" = orderRow."Id"
          AND answered."QuotedAtUtc" = orderRow."QuotedAtUtc" AND answered."Type" IN ('Approved', 'Declined'))
      AND NOT EXISTS (
        SELECT 1 FROM "Notifications" notification
        WHERE notification."BusinessId" = orderRow."BusinessId" AND notification."TargetId" = orderRow."Id"
          AND notification."EventType" = 'quotation.reminder' AND notification."CreatedAtUtc" >= orderRow."QuotedAtUtc")
    ORDER BY orderRow."QuotedAtUtc", orderRow."Id" LIMIT $2`, [now, limit]);
  for (const order of quotations.rows) {
    const version = new Date(order.QuotedAtUtc).toISOString();
    const result = await inTransaction(pool, (client) => notify(client, {
      businessId: order.BusinessId, category: 'orders', eventType: 'quotation.reminder', title: 'Quotation still awaiting approval',
      body: 'A quotation is still awaiting customer approval.', dedupeKey: `quotation.reminder:${order.Id}:${version}`,
      target: { kind: 'quotation', id: order.Id }, recipients: { permission: 'orders.manage', locationId: order.LocationId },
      email: {
        templateKey: 'quotation.reminder', subject: 'A quotation is still awaiting approval',
        text: () => 'A quotation is still awaiting customer approval. Open Avzar to review its status.',
      },
    }, { now, log }));
    results.quotationReminders += result.inApp;
  }

  const overdueInvoices = await pool.query(`
    SELECT invoice."Id", invoice."BusinessId", invoice."Number", orderRow."LocationId"
    FROM "Invoices" invoice
    JOIN "Businesses" business ON business."Id" = invoice."BusinessId" AND business."IsActive"
    LEFT JOIN "Orders" orderRow ON orderRow."BusinessId" = invoice."BusinessId" AND orderRow."Id" = invoice."OrderId"
    WHERE invoice."Status" = 'Issued'
      AND invoice."DueDate" < ($2::timestamptz AT TIME ZONE business."TimeZoneId")::date
      AND invoice."Total" - COALESCE((
        SELECT sum(payment."Amount") FROM "Payments" payment
        WHERE payment."BusinessId" = invoice."BusinessId" AND payment."InvoiceId" = invoice."Id" AND payment."Status" = 'Verified'), 0)
        - COALESCE((
        SELECT sum(credit."Amount") FROM "CreditNotes" credit
        WHERE credit."BusinessId" = invoice."BusinessId" AND credit."InvoiceId" = invoice."Id"), 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM "Notifications" notification
        WHERE notification."BusinessId" = invoice."BusinessId" AND notification."TargetId" = invoice."Id"
          AND notification."EventType" = 'invoice.overdue')
    ORDER BY invoice."DueDate", invoice."Id" LIMIT $1`, [limit, now]);
  for (const invoice of overdueInvoices.rows) {
    const result = await inTransaction(pool, (client) => notify(client, {
      businessId: invoice.BusinessId, category: 'finance', eventType: 'invoice.overdue', title: 'Invoice overdue',
      body: `Invoice ${invoice.Number} is overdue.`, dedupeKey: `invoice.overdue:${invoice.Id}`,
      target: { kind: 'invoice', id: invoice.Id },
      recipients: invoice.LocationId
        ? { permission: 'invoices.manage', locationId: invoice.LocationId }
        : { permission: 'invoices.manage', locationlessOnly: true },
      email: {
        templateKey: 'invoice.overdue', subject: 'An invoice is overdue',
        text: () => `Invoice ${invoice.Number} is overdue. Open Avzar to review it.`,
      },
    }, { now, log }));
    results.overdueInvoices += result.inApp;
  }

  results.purged = await purgeOldNotifications(pool, { now, batchLimit: limit });
  return results;
}

export function startNotificationWorker({ pool, enabled = true, intervalMinutes = 15, startupDelayMs = 30_000,
  log = console, schedule = setTimeout, cancel = clearTimeout }) {
  if (!pool || !enabled) return async () => {};
  let stopped = false;
  let timer = null;
  let running = null;

  const cycle = async () => {
    if (stopped) return;
    // Step 16a: the staff sweeps (worker overload, overdue installments) run in the same per-business pass.
    running = forEachBusiness(pool, async (businessId) => ({
      ...(await enqueueNotificationSweep(pool, { log })),
      ...(await enqueueStaffSweep(pool, { businessId, log })),
    }), { log }).then(sumResults);
    try {
      const result = await running;
      const created = result.dueSoon + result.deliveryAtRisk + result.quotationReminders + result.overdueInvoices
        + result.scheduleOverloads + result.installmentsOverdue;
      if (created || result.purged) log.info?.('Notification sweep completed.', { ...result });
    } catch (error) {
      log.error?.('Notification sweep failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error' });
    } finally {
      running = null;
    }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(1, intervalMinutes) * 60_000);
  };

  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0, startupDelayMs));
  return async () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    await running?.catch(() => {});
  };
}
