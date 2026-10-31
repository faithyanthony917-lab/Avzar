// Step 16a: the two timer-driven staff notifications. Both run once per business inside that business's own context (the same
// forEachBusiness loop as the other sweeps), so every query below sees only that business's rows under row-level security.
//   schedule.overload   a worker is planned beyond capacity in the next 7 days (shops on a plan with the shop-wide schedule only)
//   installment.overdue an installment is past its own date and still unpaid (the oldest overdue installment of each plan)
// Both are safe to repeat: the notification's deduplication key stops a second notice for the same worker and day, or the same
// plan and installment.
import { listBusinessIds } from '../db/forEachBusiness.js';
import { getWorkload } from '../auth/productionViewService.js';
import { installmentOverdueKey, notifyInstallmentOverdue, notifyScheduleOverload } from './staffEvents.js';

export const OVERLOAD_DAYS = 7;
// getWorkload reads its query like an HTTP query string, so the day count is passed as text.
const clampBatch = (value) => Math.max(1, Math.min(5000, Math.trunc(value) || 500));

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

// Loaded on first use: the installment module pulls in the payment code, which a unit test of the loop does not need.
async function defaultLoadPlans(...args) {
  const { loadActivePlans } = await import('../auth/installmentService.js');
  return loadActivePlans(...args);
}

async function overloadSweep(pool, businessId, { now, log, workload }) {
  let report;
  try {
    report = await workload(pool, { businessId }, null, { days: String(OVERLOAD_DAYS) }, now);
  } catch (error) {
    if (error?.code === 'feature_not_in_plan') return 0;
    throw error;
  }
  let sent = 0;
  for (const worker of report.workers) {
    // A day with no capacity because of approved leave is reported as a leave collision, not as an overload.
    const overDates = worker.days.filter((day) => day.status === 'over' && day.reason !== 'leave').map((day) => day.date);
    if (!overDates.length) continue;
    const result = await inTransaction(pool, (client) => notifyScheduleOverload(client,
      { businessId, worker, today: report.fromDate, overDates }, { now, log }));
    sent += result.inApp;
  }
  return sent;
}

const OVERDUE_CANDIDATES_SQL = `
  SELECT pl."InvoiceId", i."Number", o."LocationId",
    to_char(($2::timestamptz AT TIME ZONE b."TimeZoneId")::date, 'YYYY-MM-DD') AS "Today"
  FROM "InvoiceInstallmentPlans" pl
  JOIN "Invoices" i ON i."BusinessId" = pl."BusinessId" AND i."Id" = pl."InvoiceId"
  JOIN "Businesses" b ON b."Id" = pl."BusinessId" AND b."IsActive"
  LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
  WHERE pl."BusinessId" = $1 AND pl."Status" = 'Active' AND i."Status" = 'Issued'
    AND EXISTS (
      SELECT 1 FROM "InvoiceInstallments" x
      WHERE x."BusinessId" = pl."BusinessId" AND x."PlanId" = pl."Id"
        AND x."DueDate" < ($2::timestamptz AT TIME ZONE b."TimeZoneId")::date)
  ORDER BY pl."InvoiceId" LIMIT $3`;

async function installmentSweep(pool, businessId, { now, limit, log, loadPlans }) {
  const { rows } = await pool.query(OVERDUE_CANDIDATES_SQL, [businessId, now, limit]);
  if (!rows.length) return 0;
  const plans = await loadPlans(pool, businessId, rows.map((row) => row.InvoiceId), rows[0].Today);
  let sent = 0;
  for (const row of rows) {
    const plan = plans.get(row.InvoiceId);
    if (!plan || plan.state !== 'Active' || plan.overdueCount < 1) continue;
    const installment = plan.installments.find((part) => part.overdue);
    if (!installment) continue;
    const key = installmentOverdueKey(plan.id, installment.sequence);
    const { rows: seen } = await pool.query(
      'SELECT 1 FROM "Notifications" WHERE "BusinessId" = $1 AND "DeduplicationKey" = $2 LIMIT 1', [businessId, key]);
    if (seen.length) continue;
    const result = await inTransaction(pool, (client) => notifyInstallmentOverdue(client, {
      businessId, invoice: { Id: row.InvoiceId, Number: row.Number, LocationId: row.LocationId }, planId: plan.id, installment,
    }, { now, log }));
    sent += result.inApp;
  }
  return sent;
}

/**
 * One pass for one business (or every business, on a pool with no tenant wrapper). Returns the in-app notifications created.
 * A failure in one business's pass is thrown to the caller; forEachBusiness logs it and carries on with the next business.
 */
export async function enqueueStaffSweep(pool, { businessId = null, now = new Date(), batchLimit = 500, log = console, loadPlans = defaultLoadPlans, workload = getWorkload } = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const limit = clampBatch(batchLimit);
  const results = { scheduleOverloads: 0, installmentsOverdue: 0 };
  const ids = businessId ? [businessId] : await listBusinessIds(pool);
  for (const id of ids) {
    results.scheduleOverloads += await overloadSweep(pool, id, { now, log, workload });
    results.installmentsOverdue += await installmentSweep(pool, id, { now, limit, log, loadPlans });
  }
  return results;
}
